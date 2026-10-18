# AGENTS.md

## Purpose

This repository is optimized for small, high-quality SDKs that humans can understand, modify, and ship without depending on any specific coding agent.

Agents are expected to operate like senior engineers: reduce scope, preserve invariants, make failure modes explicit, and leave the codebase simpler than they found it.

The repository is the source of truth. Important decisions must exist in code, tests, ADRs, or handoff files — never only in chat history.

## Repository shape

```text
.
├── AGENTS.md
├── apps/
│   └── docs/                 # public documentation site
├── packages/
│   ├── ts/                   # reference implementation
│   ├── py/                   # language port/scaffold
│   └── go/                   # language port/scaffold
├── docs/
│   ├── product.md            # what the product is / is not
│   ├── architecture.md       # boundaries and dependency direction
│   ├── invariants.md         # guarantees that must remain true
│   ├── api.md                # intended public API
│   ├── decisions/            # ADRs: durable design decisions
│   ├── playbooks/            # release/debug/maintenance procedures
│   ├── research/             # external findings and comparisons
│   └── work/
│       ├── active.md         # current repo-wide objective
│       └── handoffs/         # task state transferred between agents
├── examples/                 # executable proof of product value
├── tooling/
│   ├── checks/               # structural/API/repository checks
│   └── scripts/              # narrow automation only
└── .github/workflows/
```

Do not add a new top-level directory unless the responsibility cannot fit an existing one cleanly.

## Engineering standard

Optimize in this order:

1. correctness
2. simplicity
3. readability
4. explicit failure behavior
5. maintainability
6. performance
7. extensibility

Do not optimize for hypothetical future requirements.

Prefer deletion over compatibility machinery when there is no demonstrated user requirement. Use platform primitives before inventing project abstractions.

A strong implementation should be understandable from the public types, filenames, and tests before reading internal details.

## Feynman test

Every public abstraction must be explainable in 2–3 plain sentences.

If an abstraction cannot be explained without introducing several other abstractions, it is probably too large or at the wrong layer.

Before adding a type, class, interface, subsystem, or directory, answer:

- What concrete problem does it solve?
- Why can an existing primitive not solve it?
- What invariant does it own?
- What code becomes simpler because it exists?

If the answers are weak, do not add it.

## Code shape

Prefer small pure functions, narrow interfaces, explicit inputs and outputs, immutable values where practical, dependency injection at stable boundaries, one obvious execution path, deliberate error handling, and boring control flow.

Avoid hidden global state, deep inheritance, generic framework layers, speculative abstractions, duplicate execution paths, boolean parameter piles, vague “manager/service/engine” types, and wrappers that only rename another API.

A function should usually fit on one screen. A file should usually stay within 150–300 LOC and must justify exceeding 400 LOC.

## Source organization

The filesystem should communicate product architecture. A contributor should locate behavior from filenames before reading implementation.

### Root source files

Keep primary public concepts at `packages/ts/src/` while their implementation remains small:

- `capability.ts`
- `schema.ts`
- `kaji.ts`
- `errors.ts`
- `index.ts`

`index.ts` is the only package barrel and contains no implementation.

### Responsibility directories

Create a directory when one concrete responsibility owns multiple cooperating files and grouping makes ownership clearer. Keep a public concept at `src/` root while it remains small; a directory should usually own roughly three or more cooperating files before it exists.

Current responsibilities:

- `execution/` — one capability invocation through Kaji
- `store/` — execution claim, settlement, replay, and storage

Do not organize source around generic architectural labels such as `core/`, `internal/`, `services/`, `types/`, `utils/`, `helpers/`, `common/`, or `shared/`.

### Filenames

Inside a responsibility directory, do not repeat the directory name in the filename. Prefer `execution/context.ts`, `execution/result.ts`, and `store/memory.ts`; avoid `execution/execution-context.ts` and `store/memory-store.ts`. Filenames should identify the concrete concept they own.

### Types

Types live beside the concept that owns them. Do not create a general `types/` directory. Execution result types belong in `execution/result.ts`; store contract types belong in `store/store.ts`.

### Barrels

Do not create nested barrel files by default. Avoid `execution/index.ts` and `store/index.ts`; internal imports name the owning file explicitly. `src/index.ts` alone defines the package's public API.

### Dependency direction within a package

Source placement implies ownership and dependency direction.

- schema must not depend on execution or store
- capability must not depend on store or the execution orchestrator
- store must not depend on execution orchestration
- execution may consume capability, errors, schema, and the store contract
- kaji constructs and configures execution but does not duplicate its pipeline
- index contains exports only

Circular dependencies are prohibited.

### Tests

Production source is grouped by implementation responsibility. Tests are grouped by observable behavior and invariant. Do not mirror the entire source filesystem mechanically in tests.

## Naming and filesystem semantics

Names are architecture.

### Files

Use filenames that describe the owned concept:

```text
capability.ts
execution/result.ts
store/memory.ts
errors.ts
approval.ts
idempotency.ts
```

Avoid vague containers:

```text
utils.ts
helpers.ts
common.ts
misc.ts
manager.ts
shared.ts
```

Create a directory only when multiple files form one cohesive subsystem. Do not mirror another language mechanically. Preserve semantic parity, not filesystem parity.

### Functions

Functions should read as actions:

```text
claimExecution()
validateInput()
resolveApproval()
recordOutcome()
```

Avoid weak names such as `handle()`, `process()`, `runThing()`, or `doWork()`.

### Types

Types should represent domain concepts, not implementation accidents.

Prefer:

```text
ExecutionClaim
ExecutionOutcome
ApprovalDecision
Capability
```

over:

```text
ExecutionData
ResultInfo
HandlerOptions2
InternalState
```

Public names should remain stable only when they deserve to become part of the product contract.

## Comments

Code should explain **what** through names and structure. Comments explain **why**.

Add a comment when it preserves engineering reasoning that is not obvious from the code, especially:

- a safety invariant
- a failure-mode decision
- a concurrency constraint
- a non-obvious platform limitation
- why a simpler-looking implementation would be incorrect

Good:

```ts
// The remote side effect may have committed before the connection failed.
// Preserve `unknown` so callers cannot blindly retry the same operation.
```

Bad:

```ts
// Set status to unknown.
status = "unknown";
```

Do not narrate syntax. Do not leave historical commentary that belongs in an ADR.

## Dependency direction

Dependencies should point inward toward simpler concepts.

```text
public API
   ↓
application semantics
   ↓
small internal primitives
   ↓
platform/runtime
```

Never make a core primitive depend on CLI, docs, examples, integrations, or a specific agent/model SDK. Framework-specific adapters must sit outside the core execution path. Circular dependencies are not allowed.

## Public API discipline

The public API is intentionally small.

Before exporting anything new:

1. prove it is required by a real use case
2. confirm callers cannot express the need through an existing primitive
3. add tests for its contract
4. update `docs/api.md`
5. update the public API snapshot/check

Internal implementation types should stay internal. Prefer one canonical way to perform an operation.


## Branch and worktree discipline

Every task gets one branch and, when worked concurrently, one isolated worktree.

### Branch names

Use:

```text
<type>/<short-kebab-description>
```

Allowed types:

```text
feat/       new user-facing behavior
fix/        bug or incorrect behavior
refactor/   structural change without behavior change
chore/      repository/tooling/maintenance work
docs/       documentation only
test/       test-only changes
perf/       performance work
ci/         CI/release automation
build/      package/build-system changes
```

Examples:

```text
feat/execution-store
fix/unknown-outcome-retry
refactor/capability-api
chore/extract-docs
docs/quickstart
ci/api-snapshot
```

Rules:

- use lowercase kebab-case
- one concern per branch
- keep names short and semantic
- never include model, agent, or engineer names
- never reuse one branch for concurrent work
- branch names describe the engineering change, not who performs it

### Worktrees

Keep concurrent work outside the primary checkout.

Recommended layout:

```text
../kaji-wt/<branch-name-with-slashes-replaced>
```

Example:

```bash
git worktree add ../kaji-wt/feat-execution-store -b feat/execution-store
```

One active owner controls one worktree at a time. Agents must not modify files owned by another active worktree unless ownership is explicitly transferred in the handoff.

Every active handoff records:

```text
Branch:
Worktree:
Owner:
Base SHA:
Head SHA:
State:
```

Repository state, commit SHA, and handoff files are authoritative. Conversation state is not.

### Lifecycle

```text
SCOPED
→ branch/worktree created
→ IMPLEMENTING
→ REVIEW
→ VERIFY
→ merge
→ remove worktree
→ delete branch
→ DONE
```

After merge:

```bash
git worktree remove ../kaji-wt/<name>
git branch -d <branch>
```

## Task state

Work moves through a small finite-state machine:

```text
SCOPED
  ↓
IMPLEMENTING
  ↓
REVIEW
  ↓
VERIFY
  ├──→ IMPLEMENTING   # defects found
  ↓
DONE
```

`BLOCKED` may be entered from any active state and must record the blocking dependency.

State is represented in repository files, not model memory.

### `docs/work/active.md`

```md
# Active work

Goal:
Reference:
Owner:
State:
Started:
Exit condition:
```

### `docs/work/handoffs/<task-id>.md`

Every task that may cross agent/session boundaries gets a handoff:

```md
# <task-id>

State:
Base SHA:
Head SHA:

## Goal
One paragraph.

## Decisions
- durable decisions only

## Changed
- files / behavior changed

## Invariants
- invariants touched or added

## Verification
- exact commands run
- result

## Remaining
- known issues or risks

## Next
One concrete next action.
```

Do not paste reasoning transcripts. Preserve conclusions, constraints, and evidence. A handoff is stale if its recorded HEAD does not match the worktree HEAD.


## Execution roles

Engineering quality must not depend on a specific model or vendor. Assign work by role and verify every role through repository state and CI.

### Design authority

Owns problem framing, boundaries, invariants, public API shape, failure semantics, and acceptance criteria.

It should produce durable decisions, not implementation volume.

### Implementer

Owns one bounded change in one worktree. It follows the frozen contract, writes focused tests, and avoids expanding scope without returning to design review.

### Adversarial reviewer

Receives the contract and diff, not the implementer's reasoning. It looks for correctness failures, race conditions, partial side effects, API leakage, unnecessary abstraction, and code that should be deleted.

The reviewer must not silently rewrite the design. Material design changes return the task to `SCOPED`.

### Mechanical contributor

Handles low-risk parallel work such as fixtures, repetitive migrations, documentation synchronization, formatting, scaffolding, and CI wiring.

Mechanical work must satisfy the same checks as core work.

### Integrator

Owns merge readiness: verifies handoff state, resolves conflicts, runs the full gate, checks public contracts, and confirms that durable docs match behavior.

No model may self-approve a material change. For non-trivial core work, implementation and final review must be independent roles.

## Work protocol

Before changing code:

1. read `AGENTS.md`
2. read the relevant product/API/invariant docs
3. inspect the current implementation and tests
4. define the smallest useful change
5. write or confirm the acceptance condition

Then:

```text
scope
→ implement
→ targeted tests
→ simplify
→ adversarial review
→ full package checks
→ handoff or merge
```

Keep changes narrow. If a task unexpectedly spreads across many unrelated files, stop and re-scope before continuing.

Do not mix architecture changes with large mechanical refactors unless the task explicitly requires both.

## Simplification pass

After a change works, review it once with the sole goal of reducing it.

Ask:

- Can a type disappear?
- Can a branch disappear?
- Can a file disappear?
- Can a platform primitive replace custom code?
- Is there more than one way to do the same thing?
- Is an abstraction used only once?
- Did the public API grow unnecessarily?

Behavior must remain unchanged during this pass.

## Review standard

Review the code as if it will be maintained for years by engineers who did not participate in the implementation.

Check correctness under failure, partial side effects, cancellation and timeout behavior, idempotency/races where state is involved, API leakage, invalid states, confusing names, unnecessary abstractions, dependency direction, test quality, comments that preserve non-obvious reasoning, and code that can be deleted.

Do not approve code only because tests pass.

## Tests

Tests should describe guarantees, not implementation details.

Prefer names such as:

```text
rejects duplicate execution with conflicting input
preserves unknown outcome after ambiguous side effect
does not execute when approval is rejected
```

Every important failure state needs a test. For stateful or concurrent code, test the race/failure boundary directly.

Examples and documentation snippets should compile or execute in CI whenever practical.

## CI contract

CI is part of the architecture.

At minimum, enforce:

```text
format
lint
typecheck
unit/integration tests
build
public API snapshot
package smoke install
examples
docs snippets
```

Repository-owned structural checks should also enforce:

- filename conventions
- forbidden vague filenames
- maximum file size / LOC
- forbidden dependency directions
- circular dependencies
- exact public exports/signatures where stability matters
- stale handoff detection when applicable

Language-specific checks:

```text
TypeScript: oxfmt, oxlint, tsc, vitest, publint, attw
Python:     ruff format/check, ty, pytest
Go:         gofmt, go vet, go test, golangci-lint
```

CI should fail loudly on semantic drift rather than relying on reviewer memory.

## Documentation

Documentation is part of the product.

```text
product.md       what / who / non-goals
architecture.md  components and boundaries
invariants.md    truths implementations must preserve
api.md           public contract
decisions/       why durable architectural choices were made
playbooks/       how recurring operational work is performed
research/        evidence, not product truth
work/            temporary execution state
```

Update durable docs only when durable behavior changes. Do not turn documentation into a chronological log.

## Definition of done

A change is done when:

- the smallest correct design is implemented
- names and files communicate intent
- failure behavior is explicit
- targeted and full checks pass
- public contracts/docs are synchronized
- unnecessary code has been removed
- no important decision exists only in agent context
- another engineer can continue from the repository alone

The desired end state is not “agent-generated code.”

It is ordinary, high-quality engineering that happens to have been produced quickly.
