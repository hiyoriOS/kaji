# release/0.3.2

State: PREPARE — not yet staged or published
Goal: Close fail-open paths and idempotency gaps found in review, with regression tests.

## Release notes

Bug-fix and hardening release. Upgrading from 0.3.1 needs no code changes for typed code. The behavior changes below can affect plain-JavaScript callers, inputs that were silently mishandled, and stores that already hold records.

### Safety fixes

- **`authorize` fails closed.** Only a return value of exactly `true` lets a request continue. `undefined` (a missing `return`), `null`, and any other value now give `denied`. Before, only `false` denied.
- **`approval` fails closed.** Approval is skipped only when the policy returns exactly `false`. `undefined`, a promise from an `async` policy, and any other value now require approval. A policy that throws gives `rejected`; before, it threw out of `kaji.execute()` and left the request's claim open, so same-key retries waited forever. `approval: null` is treated as no policy, and any other non-function value throws from `capability()`.
- **`approve()` decisions are read once.** A malformed or shape-shifting decision (for example a getter that changes its answer, or one that throws) now gives `rejected`.
- **No claim is left open.** An unexpected internal error between claim and `execute` now settles `failed` (nothing ran). An error thrown while classifying what `execute` threw settles `unknown`. Before, either could leave duplicates waiting forever.
- **`timeoutMs` is validated.** `createKaji()` throws `KajiConfigurationError` unless it is greater than 0 and at most 2,147,483,647. Before, `0`, negative, `NaN`, and too-large values were silently clamped to about 1 ms, which cancelled every request. The value is read once at creation.

### Input comparison changes

- **`Date` inputs are now compared by value.** Before, every `Date` was treated as `{}`, so two different dates under one key looked identical. **Upgrade note:** a retry of a request that 0.3.1 recorded with a `Date` input will now be reported as a key conflict (`failed`). Use a new key for those, or let existing records expire.
- **New supported values:** `bigint`, and `undefined` object properties (treated as absent, like an omitted optional field). Cross-realm `Date` values work.
- **New rejections:** `Map`, `Set`, `WeakMap`, `WeakSet`, `RegExp`, `URL`, `URLSearchParams`, `Headers`, `File`, `Blob`, boxed primitives, `Error`, `ArrayBuffer`, `DataView`, class instances that keep their data in `#private` fields, circular references, and invalid dates now reject `kaji.execute()` with `UnfingerprintableValueError`. Before, they all compared as `{}`, so different inputs could be treated as the same request. Convert them to plain data in your schema. Typed arrays, plain objects, class instances with enumerable properties, and objects with a custom `Symbol.toStringTag` (such as decimal types) are unchanged.

### Duplicate callers

- A call that waits for an identical request already in progress now stops waiting when its own `signal` aborts or `timeoutMs` elapses, and returns `unknown` (not `cancelled`: the original may still complete). Nothing is recorded for it, and retrying with the same key returns the original's real result. Before, such a call could wait forever if the original never recorded a result, and `timeoutMs` did not apply to it. If the original has already finished, its result wins over an abort.

### Docs

- Documented that `cancelled` after the claim is saved and the same key returns it again, while `cancelled` before the claim saves nothing.
- Added a tested SQLite store example (8 processes sharing one file, 1,600 requests for 200 actions, each action ran once) and a production checklist item for claims that are never recorded.
- Shorter, consistent headings across the docs site; new Input comparison and Waiting on a duplicate sections.

## Decisions

- Patch, not minor: every change makes an unsafe or silently wrong case fail loudly or safely, and no export or signature changed. The review recommended 0.4.0 because of the `Date` fingerprint change and new rejections. User chose 0.3.2.
- New exports (`InvalidInputError`, `KajiConfigurationError`, `UnfingerprintableValueError`, `ApproveHandler`) are deferred to 0.4.0.
- Tag-based, not allowlist-only, fingerprinting: objects with a custom `toStringTag` and typed arrays keep their 0.3.1 format so existing records still match.

## Verification (pre-stage, local)

- `bun run test`: 157 passed (new regression tests in `hardening.test.ts` and `fingerprint.test.ts`); typecheck, lint, format:check, build, `package:check` clean.
- Two independent adversarial reviews; all blocker and should-fix findings addressed. Mutation checks confirmed the new tests fail when each fix is reverted.
- Known and accepted: a fingerprint of a very large typed array is large and slow (pre-existing); a store that resolves `outcome` to a non-result is returned as-is.

## Remaining

1. Review and merge the PR into `main` (this branch also carries the unmerged `docs/plain-language` commits).
2. Confirm `npm view @hiyorios/kaji@0.3.2` finds nothing, then run the release playbook (STAGE, INSPECT, APPROVE with 2FA, VERIFY, FINALIZE with a signed tag `v0.3.2`).
3. In the GitHub Release body, use the notes above.
