# Public API

Kaji v0 has two primary concepts: a **capability**, which defines one application action, and a **Kaji executor**, which governs each request to run that action.

## Usage

```ts
const refund = capability({
  name: "payments.refund",
  input: schema,

  authorize: async ({ principalId, input }) => {
    return canRefund(principalId, input);
  },

  approval: ({ input }) => input.amount >= 500,

  execute: async (input, context) => {
    return refundPayment({
      ...input,
      idempotencyKey: context.idempotencyKey,
      signal: context.signal,
    });
  },
});

const kaji = createKaji({
  store: memoryStore(),
  approve: async (request) => requestHumanApproval(request),
});

const result = await kaji.execute(refund, {
  input: {
    paymentId: "pay_123",
    amount: 750,
  },
  principalId: user.id,
  idempotencyKey: request.id,
  signal: request.signal,
});
```

## Capability

`capability()` defines one named application action. It validates input, delegates authorization and optional approval policy, and calls ordinary application code only through Kaji's executor.

```ts
export type Capability<Output, Result> = {
  readonly name: string;
};

export function capability<Schema extends StandardSchemaV1, Result>(definition: {
  readonly name: string;
  readonly input: Schema;
  readonly authorize: (request: {
    readonly principalId: string;
    readonly input: SchemaOutput<Schema>;
  }) => boolean | Promise<boolean>;
  readonly approval?: (request: {
    readonly principalId: string;
    readonly input: SchemaOutput<Schema>;
  }) => boolean;
  readonly execute: (
    input: SchemaOutput<Schema>,
    context: ExecutionContext,
  ) => Result | Promise<Result>;
}): Capability<SchemaOutput<Schema>, Result>;
```

`name` is a stable, non-empty application-defined identifier.

`input` is a [Standard Schema](https://standardschema.dev) V1 schema: Zod, Valibot, ArkType, or a hand-written object exposing a `~standard` property with `version: 1` and a `validate` function. `capability()` checks this shape at construction time and rejects a schema that does not conform. Kaji never calls a schema's own methods (`parse`, `safeParse`) and never depends on a validation library; it consumes only the `~standard` protocol.

`authorize`, `approval`, and `execute` receive the schema's validated *output* type, inferred as `SchemaOutput<Schema>` from the schema's `types` field. A transforming schema's output — not its input type — flows through the capability. A schema that does not declare `types` still validates correctly at runtime; only compile-time inference is unavailable.

`authorize` receives validated input and returns whether the principal may execute the capability. Only returning `true` allows execution; `false` and any other value deny it. Throwing fails the execution before a side effect.

`approval` is optional. Returning `false` does not require approval for that request; any other value, including a Promise from an `async` policy, requires it. A thrown error settles `rejected`. Approval policy is capability-specific, while the executor obtains the approval decision.

`execute` is ordinary application code. It receives validated input and the per-execution context. It must use the supplied `AbortSignal` cooperatively when the underlying operation supports it.

Invalid input rejects `kaji.execute()` with `InvalidInputError` before any claim, authorization, approval, or execution. Its `issues` property carries the schema's Standard Schema issues verbatim (`message`, optional `path`).

`StandardSchemaV1`, `SchemaOutput`, and `InvalidInputError` are Kaji's internal names for the protocol above. None are exported from the package root; a caller writes an ordinary Standard Schema V1 schema (or uses one from Zod, Valibot, or ArkType) and never imports Kaji's internal types. `InvalidInputError` is identified by `error.name === "InvalidInputError"` and its `issues` property, not by an exported class.

## Kaji executor

`createKaji()` creates the executor. The executor owns the canonical execution path: validate, claim idempotency, authorize, obtain approval when needed, execute, and record the explicit outcome.

```ts
export function createKaji(options: {
  readonly store: ExecutionStore;
  readonly approve?: (request: {
    readonly capability: string;
    readonly principalId: string;
    readonly input: unknown;
    readonly idempotencyKey: string;
  }) =>
    | { readonly approved: boolean; readonly evidence?: unknown }
    | Promise<{ readonly approved: boolean; readonly evidence?: unknown }>;
  readonly timeoutMs?: number;
}): {
  execute<Output, Result>(
    capability: Capability<Output, Result>,
    request: ExecutionRequest,
  ): Promise<ExecutionResult<Result>>;
};
```

`timeoutMs` must be a number greater than 0 and at most 2,147,483,647; `createKaji()` throws `KajiConfigurationError` otherwise. `timeoutMs` aborts the execution's effective `AbortSignal` after the configured duration. Cancellation is cooperative. Kaji continues awaiting `execute()` until it settles, so capability code and downstream APIs must observe `context.signal` for the timeout to interrupt work. The timeout does not roll back a side effect or bound the wall-clock duration of `execute()`.

## Execution request and context

```ts
export type ExecutionRequest = {
  readonly input: unknown;
  readonly principalId: string;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
};

export type ExecutionContext = {
  readonly principalId: string;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
};
```

`principalId` and `idempotencyKey` must be non-empty strings. The caller supplies both. Kaji never infers either value from process state.

The context signal combines the caller signal and Kaji's optional timeout. It follows native `AbortSignal` semantics.

## Approval

The application supplies `approve` when any capability can require approval. Kaji passes the capability name, principal ID, validated input, and idempotency key. An absent approver, an invalid decision, a rejected decision, or an approver error prevents execution. The handler can return optional evidence, but Kaji does not expose or persist it. The application approval system must retain any required audit evidence.

## Results and outcomes

`execute()` resolves expected execution outcomes as explicit results. It can reject before Kaji establishes the execution boundary.

Examples include invalid request metadata, invalid capability input, and a store claim failure.

```ts
export type ExecutionResult<Result> =
  | {
      readonly status: "succeeded";
      readonly result: Result;
      readonly evidence: ExecutionEvidence;
    }
  | {
      readonly status: "denied" | "rejected" | "failed" | "cancelled";
      readonly error: unknown;
      readonly evidence: ExecutionEvidence;
    }
  | {
      readonly status: "unknown";
      readonly error: unknown;
      readonly evidence: ExecutionEvidence;
    };

export type ExecutionEvidence = {
  readonly executionId: string;
  readonly capability: string;
  readonly principalId: string;
  readonly idempotencyKey: string;
  readonly inputFingerprint: string;
};
```

- `succeeded` means `execute` returned successfully.
- `denied` means authorization did not allow the action.
- `rejected` means required approval was unavailable or not granted.
- `failed` means Kaji has a definitive failure for the governed request. Current cases include an idempotency conflict, an explicit `knownFailure()` from capability execution, and an unexpected internal error after the claim but before `execute` started (nothing ran).
- `cancelled` means cancellation prevented side-effect execution.
- `unknown` means Kaji cannot confirm the intended terminal result. A side effect can already have committed. If `execute` rejects after a timeout or cancellation, the result is `unknown`. A call that stops waiting for an identical in-progress request, because its signal aborted or `timeoutMs` elapsed, also returns `unknown`. Callers must not blindly retry `unknown`.

`failed` does not state whether the error is retryable, permanent, or part of a specific error category. Application policy must make those decisions.

Kaji treats a thrown or rejected `execute` call as `unknown` by default. Only application code knows whether its side effect can commit before an error surfaces. This default prevents Kaji from treating ambiguity as a retryable failure.

## Known failure

For errors from capability execution, `knownFailure(cause)` is the explicit exception to the `unknown` default. A capability's `execute` function throws it only when application code proves that no side effect committed. Kaji then settles `failed` instead of `unknown`.

```ts
export function knownFailure(cause: unknown): Error;
```

```ts
execute: async (input, context) => {
  try {
    return await provider.charge(input);
  } catch (cause) {
    if (providerRejectedBeforeCommit(cause)) throw knownFailure(cause);
    throw cause; // stays unknown: the side effect may have committed
  }
},
```

`knownFailure()` only wraps `cause` for Kaji to recognize. It does not change the meaning of the underlying error.

Kaji never infers this classification from an error class, message, or status code. Only application code that proves no side effect committed can throw `knownFailure()`.

Every other thrown or rejected `execute` call settles `unknown`.

A repeated execution with the same capability, principal ID, idempotency key, and input fingerprint returns the recorded result. Reuse of that capability, principal ID, and idempotency key with a different validated input fingerprint returns a conflict as a `failed` result. The same idempotency key can identify separate executions under a different capability or principal. A concurrent duplicate waits for or receives the same recorded outcome, and stops waiting with `unknown` if its own signal aborts or `timeoutMs` elapses, because the original may still complete. It must not run `execute` again.

## Execution store

The store tracks execution identity, idempotency claims, input fingerprints, outcomes, and minimal result or error evidence.

Its claim operation must prevent duplicate execution for the same operation under concurrency.

```ts
export type ExecutionClaim = {
  readonly capability: string;
  readonly principalId: string;
  readonly idempotencyKey: string;
  readonly inputFingerprint: string;
};

export type StoredExecution = ExecutionResult<unknown>;

export type ClaimResult =
  | { readonly status: "claimed"; readonly executionId: string }
  | { readonly status: "existing"; readonly outcome: Promise<StoredExecution> }
  | { readonly status: "conflict"; readonly executionId: string };

export type ExecutionStore = {
  claim(claim: ExecutionClaim): Promise<ClaimResult>;
  record(execution: StoredExecution): Promise<void>;
};

export function memoryStore(): ExecutionStore;
```

`ExecutionClaim`, `ClaimResult`, and `StoredExecution` are public only because custom stores must implement the contract. `claim()` atomically creates a claim, returns the outcome promise for an identical active or settled claim, or reports conflicting reuse. The in-memory store is process-local and is the only v0 implementation.

Kaji does not provide a database store, distributed lock, event stream, retry system, or recovery worker in v0.

## Export boundary

The intended v0 exports are:

```ts
export { capability, createKaji, knownFailure, memoryStore };

export type {
  Capability,
  ClaimResult,
  ExecutionClaim,
  ExecutionContext,
  ExecutionEvidence,
  ExecutionRequest,
  ExecutionResult,
  ExecutionStore,
  StoredExecution,
};
```

`ExecutionClaim`, `ClaimResult`, and `StoredExecution` are exported from the
package root because custom stores must implement the contract. The package
ships one public entry point; no framework adapters, implementation
internals, or additional convenience APIs are part of v0.
