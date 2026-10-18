# Kaji

Kaji is an embedded execution layer for application actions requested by agents, automations, and other callers.

Your application already has functions such as `refundPayment()` or `cancelBooking()`. Kaji puts one governed boundary in front of those functions.

That boundary validates input, claims the execution identity, checks authorization, requests approval when required, executes the action, and records the result.

Kaji is a TypeScript library with zero runtime dependencies. It runs inside your application. It does not require a Kaji server, database, or control plane.

Invalid capability input rejects with an `InvalidInputError` before Kaji claims, authorizes, or executes anything. Its `issues` property carries the schema's [Standard Schema](https://standardschema.dev) issues verbatim.

## Install

```bash
npm install @hiyori/kaji zod
```

Kaji accepts any [Standard Schema](https://standardschema.dev) V1 schema as `input`. This example uses Zod, but Valibot, ArkType, and hand-written schemas work the same way.

## Minimal example

```ts
import { capability, createKaji, memoryStore } from "@hiyori/kaji";
import { z } from "zod";

const refunds = new Map<string, number>();

const refundPayment = capability({
  name: "payments.refund",
  input: z.object({
    paymentId: z.string().min(1),
    amount: z.number().positive(),
  }),
  authorize: ({ principalId }) => principalId.startsWith("user_"),
  execute: async ({ paymentId, amount }, context) => {
    refunds.set(paymentId, amount);
    return { refundId: `refund:${context.idempotencyKey}`, amount };
  },
});

const kaji = createKaji({ store: memoryStore() });

const outcome = await kaji.execute(refundPayment, {
  input: { paymentId: "pay_123", amount: 50 },
  principalId: "user_123",
  idempotencyKey: "refund_pay_123_v1",
});

if (outcome.status === "succeeded") {
  console.log(outcome.result.refundId);
}
```

`memoryStore()` is process-local and non-durable. Use it for development, tests, and examples. Production guarantees depend on the `ExecutionStore` that you provide.

## Execution lifecycle

`kaji.execute()` uses one fixed order:

1. Validate the request input.
2. Claim the capability, principal ID, and caller-supplied idempotency key.
3. Check application authorization.
4. Request application approval when the capability requires it.
5. Call the capability `execute` function at most once for that stored claim.
6. Record the terminal result.

A repeated request with the same identity and input returns the stored result. Kaji does not call the capability again.

The execution identity contains the capability name, `principalId`, and `idempotencyKey`. Reuse with different validated input returns `status: "failed"` as a conflict.

## Result statuses

`execute()` returns an `ExecutionResult` with one of six status values:

- `succeeded`: The capability returned a result, and the store recorded it.
- `denied`: The authorization function returned `false` or threw.
- `rejected`: Required approval was missing, invalid, rejected, or unavailable.
- `failed`: Kaji has a definitive failure. Current cases include idempotency conflicts and explicit `knownFailure()` results.
- `cancelled`: Cancellation stopped the request before capability execution began.
- `unknown`: Kaji could not prove the final result. Do not blindly retry this status.

A thrown or rejected capability execution becomes `unknown` by default. The side effect can commit before the error reaches Kaji.

Application code can throw `knownFailure(cause)` only when it knows that no side effect committed. Kaji then returns `status: "failed"`.

`failed` does not state whether an error is retryable or permanent. Your application owns that policy.

```ts
import { knownFailure } from "@hiyori/kaji";

try {
  return await provider.refund(input, { signal: context.signal });
} catch (cause) {
  if (providerRejectedBeforeCommit(cause)) throw knownFailure(cause);
  throw cause;
}
```

A store failure while Kaji records a terminal result also returns `unknown`. The status does not promise that the capability started.

## Idempotency and durability

Kaji prevents duplicate capability execution through the configured `ExecutionStore`. The store must claim one operation atomically and return the recorded outcome to duplicate callers.

Kaji does not provide globally distributed exactly-once execution. Cross-process and restart guarantees depend on your store implementation.

Kaji also does not make an external provider idempotent. Pass `context.idempotencyKey` to the provider when the provider supports idempotency.

## Authorization and approval

Your application owns authorization policy. Each capability receives the validated input and the caller-supplied `principalId`.

Kaji checks authorization before it calls the capability. A denied request returns `denied` and does not execute the application action.

A capability can declare when approval is required. Your application supplies the approval handler, approval policy, user interface, and identity checks.

Kaji accepts optional approval evidence but does not expose or persist it. Your approval system must retain any required audit evidence.

Approval fails closed. Missing, invalid, rejected, or failed approval returns `rejected` and prevents capability execution.

## Timeout and cancellation

Kaji passes an `AbortSignal` to the capability through `ExecutionContext`. A caller signal and the optional `timeoutMs` value feed this signal.

`timeoutMs` aborts the effective signal after the configured duration. Kaji still awaits `execute()` until it settles, so the capability must observe the signal to interrupt work.

Cancellation before capability execution returns `cancelled`. When `execute()` rejects after an abort, Kaji returns `unknown` because a side effect can already have committed.

If `execute()` ignores the signal and later resolves, Kaji can return `succeeded`. An abort does not prove rollback or that a remote operation stopped.

## Responsibility boundary

Kaji owns:

- the execution order
- input validation before policy and effects
- idempotency claim coordination through the configured store
- authorization and approval enforcement
- explicit result classification
- minimal execution evidence

Your application owns:

- capability definitions
- caller identity and `principalId`
- authorization policy
- approval policy, interface, and evidence
- the `ExecutionStore` used in production
- provider calls and provider-side idempotency
- reconciliation for `unknown` outcomes
- business audit data and observability

## What Kaji is not

Kaji is not an agent framework, workflow engine, IAM system, approval product, retry service, database, distributed lock service, event store, or recovery worker.

Kaji does not choose tools or plan actions. It governs the point where approved application code can create a real side effect.

## Documentation

- [Getting started](https://kaji.build/docs/getting-started)
- [Architecture](https://kaji.build/docs/architecture)
- [Outcomes](https://kaji.build/docs/concepts/outcomes)
- [Stores](https://kaji.build/docs/concepts/stores)
- [API reference](https://kaji.build/docs/reference/api)
- [Refund example](https://kaji.build/docs/reference/refund-example)

The repository contains the runnable proof example at `examples/refund`.

## Repository development

This repository uses Bun 1.3.11.

```bash
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
bun run package:check
bun run package:smoke
bun run example:refund
```

See `AGENTS.md` before you make repository changes.
