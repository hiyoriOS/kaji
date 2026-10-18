import type { ApproveHandler } from "./execution/approval.ts";
import type { Capability } from "./capability.ts";
import { executeCapability, type ExecuteDependencies } from "./execution/execute.ts";
import type { ExecutionRequest } from "./execution/request.ts";
import type { ExecutionResult } from "./execution/result.ts";
import type { ExecutionStore } from "./store/store.ts";
import { KajiConfigurationError } from "./errors.ts";

/** The largest delay `setTimeout` honors; larger values fire immediately. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Stable application configuration for the executor, per docs/api.md. */
export type KajiOptions = {
  readonly store: ExecutionStore;
  readonly approve?: ApproveHandler;
  readonly timeoutMs?: number;
};

/** The Kaji executor, as frozen by docs/api.md. */
export type Kaji = {
  execute<Input, Result>(
    capability: Capability<Input, Result>,
    request: ExecutionRequest,
  ): Promise<ExecutionResult<Result>>;
};

/**
 * Creates the Kaji executor: the one canonical entry point for running a
 * capability. `kaji.execute()` validates the request, claims its
 * idempotency key, authorizes and approves it, calls the capability at
 * most once, and records the explicit outcome.
 */
export function createKaji(options: KajiOptions): Kaji {
  const { timeoutMs } = options;
  if (
    timeoutMs !== undefined &&
    !(typeof timeoutMs === "number" && timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS)
  ) {
    throw new KajiConfigurationError(
      `createKaji() timeoutMs must be a number greater than 0 and at most ${MAX_TIMEOUT_MS}.`,
    );
  }
  // Snapshot validated options so later mutation of `options` cannot bypass
  // the checks above.
  const dependencies: ExecuteDependencies = {
    store: options.store,
    ...(options.approve === undefined ? {} : { approve: options.approve }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  return {
    execute(capability, request) {
      return executeCapability(dependencies, capability, request);
    },
  };
}
