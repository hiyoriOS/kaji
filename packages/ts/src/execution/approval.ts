/**
 * What Kaji tells an application's `approve` handler about one request
 * requiring approval, per docs/api.md's inline `createKaji()` contract.
 * Not exported: docs/api.md keeps this shape inline in `KajiOptions`
 * rather than naming it, so there is no caller need to import it directly.
 */
export type ApprovalRequest = {
  readonly capability: string;
  readonly principalId: string;
  readonly input: unknown;
  readonly idempotencyKey: string;
};

/** What an application's `approve` handler returns for one request. */
export type ApprovalDecision = {
  readonly approved: boolean;
  readonly evidence?: unknown;
};

export type ApproveHandler = (
  request: ApprovalRequest,
) => ApprovalDecision | Promise<ApprovalDecision>;

/**
 * Resolves whether a request that requires approval may proceed.
 *
 * Approval is fail-closed (docs/invariants.md "Approval is fail-closed"):
 * a missing handler, an invalid decision shape, a rejected decision, or a
 * thrown/rejected handler all prevent execution. Only an explicit
 * `{ approved: true }` allows the caller to continue.
 */
export async function resolveApproval(
  approve: ApproveHandler | undefined,
  request: ApprovalRequest,
): Promise<{ approved: true } | { approved: false; error: unknown }> {
  if (approve === undefined) {
    return {
      approved: false,
      error: new Error("Approval is required but no approve handler was configured."),
    };
  }

  // Read `approved` exactly once, inside the guard: a getter or Proxy must
  // not be able to answer differently to the type check and the decision,
  // or throw outside the guard.
  try {
    const decision: unknown = await approve(request);
    if (typeof decision !== "object" || decision === null) {
      return { approved: false, error: invalidDecision() };
    }
    const approved = (decision as { approved?: unknown }).approved;
    if (approved !== true && approved !== false) {
      return { approved: false, error: invalidDecision() };
    }
    if (approved === false) {
      return { approved: false, error: new Error("Approval was not granted.") };
    }
    return { approved: true };
  } catch (cause) {
    return { approved: false, error: cause };
  }
}

function invalidDecision(): Error {
  return new Error("approve() returned an invalid decision; expected { approved: boolean }.");
}
