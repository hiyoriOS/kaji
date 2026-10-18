# Kaji

Run application actions, like refunding a payment or cancelling a booking, safely when an agent, automation, or API caller asks for them.

Kaji checks the input, checks that the caller is allowed, asks for approval when needed, runs your function once per request, and tells you what happened. It is a TypeScript library with no dependencies. It runs inside your app, with no server or database to set up.

## Install

```bash
npm install @hiyorios/kaji zod
```

Input validation works with any [Standard Schema](https://standardschema.dev) library, including Zod, Valibot, and ArkType.

## Usage

```ts
import { capability, createKaji, memoryStore } from "@hiyorios/kaji";
import { z } from "zod";

const refundPayment = capability({
  name: "payments.refund",
  input: z.object({
    paymentId: z.string().min(1),
    amount: z.number().positive(),
  }),
  authorize: ({ principalId }) => principalId.startsWith("user_"),
  execute: async ({ paymentId, amount }, context) => {
    // Call your payment provider here.
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

`memoryStore()` keeps records in memory for one process. Use it for development and tests. In production, pass a store that saves to a database (see [Stores](https://kaji.build/docs/concepts/stores)).

## Results

`kaji.execute()` resolves with a `status`:

| Status      | Meaning                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------- |
| `succeeded` | The action ran and returned a result.                                                         |
| `denied`    | `authorize` returned `false` or threw. The action did not run.                                |
| `rejected`  | Approval was required and not given. The action did not run.                                  |
| `failed`    | The request definitely failed: a reused key with different input, or a `knownFailure()` you threw. |
| `cancelled` | The request was cancelled before the action started.                                          |
| `unknown`   | The action started, but Kaji cannot tell whether it finished. Do not retry it blindly.        |

Input that fails validation rejects `execute()` with an `InvalidInputError` instead.

## Retries

Calling `execute()` again with the same capability, `principalId`, `idempotencyKey`, and input returns the saved result without running the action again. Reusing the key with different input returns `failed`.

## When the action throws

If your function throws after it starts, Kaji returns `unknown`, because the side effect may already have happened. If you know that nothing happened, throw `knownFailure(cause)` and Kaji returns `failed`.

```ts
import { knownFailure } from "@hiyorios/kaji";

try {
  return await provider.refund(input, {
    idempotencyKey: context.idempotencyKey,
    signal: context.signal,
  });
} catch (cause) {
  if (providerRejectedBeforeCommit(cause)) throw knownFailure(cause);
  throw cause;
}
```

Pass `context.idempotencyKey` to your provider when it supports one, so a retry cannot charge or refund twice.

## Documentation

- [Getting started](https://kaji.build/docs/getting-started)
- [Capabilities](https://kaji.build/docs/concepts/capability)
- [Outcomes](https://kaji.build/docs/concepts/outcomes)
- [Stores](https://kaji.build/docs/concepts/stores)
- [API reference](https://kaji.build/docs/reference/api)

To work on Kaji itself, see [development](https://github.com/hiyoriOS/kaji/blob/main/docs/playbooks/development.md).

## License

[FSL-1.1-ALv2](https://github.com/hiyoriOS/kaji/blob/main/LICENSE)
