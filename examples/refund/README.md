# Refund example

Proves that `@hiyorios/kaji` is sufficient to govern a realistic,
state-changing application action end to end.

## What this proves

- The application defines its own domain logic (`payments.refund()`,
  `canRefund()`), input validation (Zod), and authorization rule. Kaji
  never sees or contains any of that.
- A fresh refund request validates, authorizes, requires approval above
  a threshold, executes exactly once, and settles `succeeded`.
- Retrying the exact same request (same capability, principal,
  idempotency key, input) returns the recorded result instead of
  charging the payment provider a second time.
- A refund whose remote acknowledgement is lost after the provider may
  have already committed it settles `unknown`, not `failed` — and
  retrying that same operation does not call the capability again or
  duplicate the side effect.
- A refund the provider can prove was never charged (declined before any
  commit) uses `knownFailure()` to settle an ordinary `failed`, distinct
  from the ambiguous case above.

## Run it

```bash
bun install
bun run example:refund
```

or, from this directory:

```bash
bun run start
```

The script exits non-zero if any of the proofs above fail; console
output is for readability, not verification.

## The application / Kaji boundary

`payments.ts` is a fake external payment provider: it tracks its own
committed refunds by idempotency key, the way a real provider like
Stripe would. That is provider-side idempotency, not Kaji's — Kaji
never sees it and does not rely on it.

`app.ts` defines one capability, `payments.refund`. Its `authorize` hook
calls the application's own `canRefund()`; its `approval` hook declares
that refunds of $500 or more require approval; its `execute` function is
ordinary application code that calls the fake provider. The host
application supplies `approve()` to `createKaji()` — Kaji enforces the
approval boundary, but never decides how a decision is obtained.

Kaji's executor, created once via `createKaji()`, is the only thing that
calls `execute`. It validates input, claims the caller-supplied
idempotency key, authorizes, obtains approval, runs the capability at
most once, and records an explicit outcome — `succeeded`, `failed`, or
`unknown` in this example.

`memoryStore()` is a process-local, in-memory `ExecutionStore`. It is
useful for local development, tests, and examples like this one, but it
is not durable: nothing it records survives a process restart. A
production deployment needs a durable `ExecutionStore` implementation.
