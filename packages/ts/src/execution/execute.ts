import { capabilityDefinition, type Capability, type CapabilityDefinition } from "../capability.ts";
import { resolveApproval, type ApproveHandler } from "./approval.ts";
import { effectiveSignal } from "./signal.ts";
import type { ExecutionContext } from "./context.ts";
import type { ExecutionEvidence, ExecutionResult } from "./result.ts";
import type { ExecutionRequest } from "./request.ts";
import type { ExecutionStore } from "../store/store.ts";
import { fingerprintInput } from "../store/fingerprint.ts";
import { KajiConfigurationError, KnownFailure } from "../errors.ts";
import { validateInput, type StandardSchemaV1 } from "../schema.ts";

export type ExecuteDependencies = {
  readonly store: ExecutionStore;
  readonly approve?: ApproveHandler;
  readonly timeoutMs?: number;
};

/**
 * Runs the one canonical Kaji execution path for one request, in the exact
 * order docs/api.md freezes: validate, claim idempotency, authorize,
 * obtain approval when needed, execute, and record the explicit outcome.
 *
 * Claiming before authorization is deliberate: claiming an idempotency key
 * is bookkeeping, not the side effect docs/invariants.md's "Authorization
 * precedes side effects" protects. It lets a denied or rejected request
 * still occupy and settle its idempotency key, so a caller who retries a
 * denied request with the same key observes the same denial instead of a
 * fresh authorization check racing a duplicate claim.
 */
export async function executeCapability<Input, Result>(
  dependencies: ExecuteDependencies,
  capability: Capability<Input, Result>,
  request: ExecutionRequest,
): Promise<ExecutionResult<Result>> {
  const definition = capabilityDefinition(capability);
  const principalId = requireNonEmptyString(request.principalId, "principalId");
  const idempotencyKey = requireNonEmptyString(request.idempotencyKey, "idempotencyKey");
  const { signal, cleanup } = effectiveSignal(request.signal, dependencies.timeoutMs);

  try {
    if (signal.aborted) {
      return cancelled(capability.name, principalId, idempotencyKey);
    }

    // Standard Schema validation may be asynchronous. A third-party
    // validator cannot be cancelled through Kaji's signal, so the signal
    // is re-checked once validation settles: an aborted request must never
    // proceed to fingerprinting, claiming, or execution.
    const input = await validateInput(definition.input, request.input);
    if (signal.aborted) {
      return cancelled(capability.name, principalId, idempotencyKey);
    }
    const inputFingerprint = fingerprintInput(capability.name, input);

    const claimResult = await claim(dependencies.store, {
      capability: capability.name,
      principalId,
      idempotencyKey,
      inputFingerprint,
    });

    if (claimResult.status === "conflict") {
      return conflict(
        capability.name,
        principalId,
        idempotencyKey,
        claimResult.executionId,
        inputFingerprint,
      );
    }
    if (claimResult.status === "existing") {
      // A concurrent or retried caller observes the same recorded outcome
      // instead of running the capability again (docs/api.md: "it must
      // not run `execute` again").
      return await awaitExisting<Result>(claimResult.outcome, signal, () =>
        stoppedWaiting(capability.name, principalId, idempotencyKey, inputFingerprint),
      );
    }

    const evidence: ExecutionEvidence = {
      executionId: claimResult.executionId,
      capability: capability.name,
      principalId,
      idempotencyKey,
      inputFingerprint,
    };

    // Everything before `execute` is wrapped so an unexpected internal error
    // (a throwing getter on an approval decision, a malformed store
    // result) still settles the claim instead of leaving every later
    // duplicate waiting on it. Nothing has run yet, so this is a plain
    // `failed`.
    let early: ExecutionResult<never> | undefined;
    try {
      early = await beforeExecute(dependencies, definition, {
        signal,
        evidence,
        input,
      });
    } catch (error) {
      early = await settle(dependencies.store, failedBeforeExecute(evidence, error));
    }
    if (early !== undefined) {
      return early;
    }

    // From this line on, an external side effect may have started. Kaji
    // can no longer prove the action did not begin, so every failure path
    // below settles `unknown` rather than an ordinary failure.
    const context: ExecutionContext = { principalId, idempotencyKey, signal };
    const outcome = await runCapability(definition.execute, input, context, evidence);
    return await settle(dependencies.store, outcome);
  } finally {
    cleanup();
  }
}

/**
 * Runs the checks that sit between claiming and `execute`: cancellation,
 * authorization, and approval. Returns the settled terminal result when one
 * of them stops the request, or `undefined` when `execute` may run.
 */
async function beforeExecute<Input, Result>(
  dependencies: ExecuteDependencies,
  definition: CapabilityDefinition<StandardSchemaV1<unknown, Input>, Result>,
  state: { signal: AbortSignal; evidence: ExecutionEvidence; input: Input },
): Promise<ExecutionResult<never> | undefined> {
  const { signal, evidence, input } = state;
  const { principalId } = evidence;
  const cancelNow = () =>
    settle(
      dependencies.store,
      cancelled(evidence.capability, principalId, evidence.idempotencyKey, evidence),
    );

  if (signal.aborted) {
    return await cancelNow();
  }

  const authorization = await guarded(() => definition.authorize({ principalId, input }));
  if (!authorization.ok) {
    return await settle(dependencies.store, denied(evidence, authorization.error));
  }
  // Fail closed: only an explicit `true` authorizes. `false`, and any
  // other value a caller outside the type system could return (such as
  // `undefined` from a forgotten `return`), denies.
  if (authorization.value !== true) {
    const message =
      authorization.value === false
        ? "Authorization denied the request."
        : "authorize() must return true or false; treating the result as a denial.";
    return await settle(dependencies.store, denied(evidence, new Error(message)));
  }

  if (signal.aborted) {
    return await cancelNow();
  }

  // The policy is synchronous by contract, so it is called without
  // `await`: a thenable result must not be resolved into an answer.
  let needsApproval = false;
  if (typeof definition.approval === "function") {
    try {
      needsApproval = requiresApproval(definition.approval({ principalId, input }));
    } catch (error) {
      // A policy that cannot answer cannot waive approval.
      return await settle(dependencies.store, rejected(evidence, error));
    }
  }
  if (needsApproval) {
    const decision = await resolveApproval(dependencies.approve, {
      capability: evidence.capability,
      principalId,
      input,
      idempotencyKey: evidence.idempotencyKey,
    });
    if (!decision.approved) {
      return await settle(dependencies.store, rejected(evidence, decision.error));
    }
  }

  if (signal.aborted) {
    return await cancelNow();
  }

  return undefined;
}

/**
 * Fail closed: approval is skipped only when the policy returns exactly
 * `false`. A policy is synchronous, so a thenable (an `async` policy) is not
 * an answer; it requires approval, and its eventual rejection is absorbed
 * so it cannot surface as an unhandled rejection.
 */
function requiresApproval(value: unknown): boolean {
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as PromiseLike<unknown>).then === "function"
  ) {
    (value as PromiseLike<unknown>).then(undefined, () => {});
  }
  return value !== false;
}

/**
 * Waits for the outcome of a request another caller claimed, but stops
 * waiting when this call's signal aborts. An outcome that has already
 * settled always wins over an abort.
 *
 * Giving up is `unknown`, never `cancelled`: the original request is still
 * running (or finished) and may commit its side effect, so this caller
 * cannot claim that nothing happened. Nothing is recorded, because the
 * claim belongs to the other caller.
 */
const ABORTED = Symbol("aborted");

async function awaitExisting<Result>(
  outcome: Promise<unknown>,
  signal: AbortSignal,
  onAbort: () => ExecutionResult<never>,
): Promise<ExecutionResult<Result>> {
  let listener: (() => void) | undefined;
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    if (signal.aborted) {
      resolve(ABORTED);
      return;
    }
    listener = () => resolve(ABORTED);
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    // `outcome` is listed first so that, if both are already settled, the
    // real result is returned.
    const winner = await Promise.race([outcome, aborted]);
    return winner === ABORTED ? onAbort() : (winner as ExecutionResult<Result>);
  } finally {
    if (listener !== undefined) {
      signal.removeEventListener("abort", listener);
    }
  }
}

async function runCapability<Input, Result>(
  execute: (input: Input, context: ExecutionContext) => Result | Promise<Result>,
  input: Input,
  context: ExecutionContext,
  evidence: ExecutionEvidence,
): Promise<ExecutionResult<Result>> {
  try {
    const result = await execute(input, context);
    return { status: "succeeded", result, evidence };
  } catch (cause) {
    // A thrown or rejected `execute` call is `unknown` by default: only
    // application code knows whether its own side effect committed before
    // the error surfaced (docs/api.md). `KnownFailure` is the one explicit
    // exception — application code asserting no side effect committed —
    // and settles `failed` instead.
    // `instanceof` can itself throw (for example on a hostile Proxy), and
    // `execute` has already run by this point, so any failure to classify
    // the error must still settle `unknown`.
    try {
      if (cause instanceof KnownFailure) {
        return { status: "failed", error: cause.cause, evidence };
      }
    } catch {
      // fall through
    }
    return { status: "unknown", error: cause, evidence };
  }
}

async function claim(
  store: ExecutionStore,
  executionClaim: Parameters<ExecutionStore["claim"]>[0],
) {
  try {
    return await store.claim(executionClaim);
  } catch (cause) {
    throw new KajiConfigurationError("Execution store failed to claim the operation.", { cause });
  }
}

/**
 * Persists a terminal outcome and returns it. A store failure here means
 * Kaji cannot prove the outcome was durably recorded; docs/invariants.md
 * requires that ambiguity to surface as `unknown` rather than the
 * capability's real outcome, since a caller could otherwise be told an
 * action succeeded that Kaji has no durable record of.
 */
async function settle<Result>(
  store: ExecutionStore,
  outcome: ExecutionResult<Result>,
): Promise<ExecutionResult<Result>> {
  try {
    await store.record(outcome);
    return outcome;
  } catch (cause) {
    return { status: "unknown", error: cause, evidence: outcome.evidence };
  }
}

async function guarded<Value>(
  fn: () => Value | Promise<Value>,
): Promise<{ ok: true; value: Value } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

function failedBeforeExecute(evidence: ExecutionEvidence, cause: unknown): ExecutionResult<never> {
  return {
    status: "failed",
    error: new Error("Kaji hit an internal error before running the action. Nothing ran.", {
      cause,
    }),
    evidence,
  };
}

function stoppedWaiting(
  capability: string,
  principalId: string,
  idempotencyKey: string,
  inputFingerprint: string,
): ExecutionResult<never> {
  return {
    status: "unknown",
    error: new Error(
      "Stopped waiting for an identical request that is already in progress. It may still complete; retry with the same idempotencyKey to read its result.",
    ),
    evidence: { executionId: "", capability, principalId, idempotencyKey, inputFingerprint },
  };
}

function denied(evidence: ExecutionEvidence, error: unknown): ExecutionResult<never> {
  return { status: "denied", error, evidence };
}

function rejected(evidence: ExecutionEvidence, error: unknown): ExecutionResult<never> {
  return { status: "rejected", error, evidence };
}

function conflict(
  capability: string,
  principalId: string,
  idempotencyKey: string,
  executionId: string,
  inputFingerprint: string,
): ExecutionResult<never> {
  return {
    status: "failed",
    error: new Error(
      `Idempotency key "${idempotencyKey}" was already used for a different request.`,
    ),
    evidence: { executionId, capability, principalId, idempotencyKey, inputFingerprint },
  };
}

function cancelled(
  capability: string,
  principalId: string,
  idempotencyKey: string,
  evidence?: ExecutionEvidence,
): ExecutionResult<never> {
  return {
    status: "cancelled",
    error: new Error("Execution was cancelled before it began."),
    evidence: evidence ?? {
      executionId: "",
      capability,
      principalId,
      idempotencyKey,
      inputFingerprint: "",
    },
  };
}

function requireNonEmptyString(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new KajiConfigurationError(`ExecutionRequest.${field} must be a non-empty string.`);
  }
  return value;
}
