/**
 * Proof example: a payment refund action governed by @hiyorios/kaji.
 *
 * This file answers the questions a developer evaluating the package
 * would ask: what do I wrap, where does my business logic stay, how do I
 * identify the caller, how do approvals work, where does the idempotency
 * key come from, what happens on a duplicate request, and what happens
 * when a remote side effect may have succeeded but the response is lost.
 *
 * Everything above the `capability()`/`createKaji()` calls is ordinary
 * application code. Kaji only governs the boundary between a request and
 * `payments.refund()` actually running.
 */
import assert from "node:assert/strict";
import { z } from "zod";
import { capability, createKaji, knownFailure, memoryStore } from "@hiyorios/kaji";
import {
  AcknowledgementLostError,
  PaymentDeclinedError,
  createPaymentService,
} from "./payments.ts";

const RefundInput = z.object({
  paymentId: z.string().min(1),
  amount: z.number().positive(),
});

const payments = createPaymentService();

// The application owns authorization: only the payment's owner may refund it.
function canRefund(principalId: string, paymentId: string): boolean {
  return payments.ownerOf(paymentId) === principalId;
}

const refund = capability({
  name: "payments.refund",
  input: RefundInput,

  authorize: async ({ principalId, input }) => canRefund(principalId, input.paymentId),

  // The capability decides when approval is required; Kaji enforces it.
  approval: ({ input }) => input.amount >= 500,

  execute: async (input, context) => {
    try {
      return await payments.refund({
        ...input,
        idempotencyKey: context.idempotencyKey,
        signal: context.signal,
      });
    } catch (cause) {
      if (cause instanceof PaymentDeclinedError) {
        // The provider proved the refund was never charged: a known,
        // ordinary failure, not an ambiguous one.
        throw knownFailure(cause);
      }
      throw cause; // anything else stays unknown: the side effect may have committed
    }
  },
});

const ambiguousRefund = capability({
  name: "payments.refund.ambiguous",
  input: RefundInput,
  authorize: async ({ principalId, input }) => canRefund(principalId, input.paymentId),
  approval: ({ input }) => input.amount >= 500,
  execute: async (input, context) => {
    // The provider commits the refund, then the acknowledgement is lost.
    // Kaji cannot prove completion, so it must settle `unknown`.
    return await payments.refundWithLostAcknowledgement({
      ...input,
      idempotencyKey: context.idempotencyKey,
      signal: context.signal,
    });
  },
});

// The host application decides how approval is obtained. This example
// approves deterministically; a real application might page a human.
const kaji = createKaji({
  store: memoryStore(),
  approve: async () => ({ approved: true }),
});

async function main() {
  // --- Happy path: a fresh refund executes once. ---
  const first = await kaji.execute(refund, {
    input: { paymentId: "pay_123", amount: 750 },
    principalId: "user_123",
    idempotencyKey: "refund_req_123",
  });
  assert.equal(first.status, "succeeded");
  assert.equal(payments.committedRefundCount(), 1);
  console.log(`refund completed: ${first.status === "succeeded" ? first.result.refundId : ""}`);
  console.log(`refund executions: ${payments.committedRefundCount()}`);

  // --- Replay proof: the identical request does not execute twice. ---
  const replay = await kaji.execute(refund, {
    input: { paymentId: "pay_123", amount: 750 },
    principalId: "user_123",
    idempotencyKey: "refund_req_123",
  });
  assert.deepEqual(replay, first);
  assert.equal(payments.committedRefundCount(), 1);
  console.log(`duplicate replayed: ${replay.status === "succeeded"}`);
  console.log(`refund executions: ${payments.committedRefundCount()}`);

  // --- Ambiguous remote result: a lost acknowledgement becomes unknown. ---
  const ambiguous = await kaji.execute(ambiguousRefund, {
    input: { paymentId: "pay_123", amount: 600 },
    principalId: "user_123",
    idempotencyKey: "refund_req_ambiguous",
  });
  assert.equal(ambiguous.status, "unknown");
  assert.ok(ambiguous.status === "unknown" && ambiguous.error instanceof AcknowledgementLostError);
  assert.equal(payments.committedRefundCount(), 2);
  console.log(`ambiguous refund outcome: ${ambiguous.status}`);
  console.log(`ambiguous refund executions: ${payments.committedRefundCount()}`);

  // --- Unknown retry proof: retrying the same operation does not
  // re-execute the capability or duplicate the side effect. ---
  const retry = await kaji.execute(ambiguousRefund, {
    input: { paymentId: "pay_123", amount: 600 },
    principalId: "user_123",
    idempotencyKey: "refund_req_ambiguous",
  });
  assert.deepEqual(retry, ambiguous);
  assert.equal(payments.committedRefundCount(), 2);
  console.log(`retry outcome: ${retry.status}`);
  console.log(`ambiguous refund executions: ${payments.committedRefundCount()}`);

  // --- Known failure: a definitively declined refund settles `failed`,
  // not `unknown`, and is distinct from the ambiguous case above. ---
  const declined = await kaji.execute(refund, {
    input: { paymentId: "pay_123", amount: 5000 },
    principalId: "user_123",
    idempotencyKey: "refund_req_declined",
  });
  assert.equal(declined.status, "failed");
  assert.ok(declined.status === "failed" && declined.error instanceof PaymentDeclinedError);
  assert.equal(payments.committedRefundCount(), 2);
  console.log(`declined refund outcome: ${declined.status}`);
  console.log(`refund executions: ${payments.committedRefundCount()}`);
}

await main();
