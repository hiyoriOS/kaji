# Development

Commands for working on Kaji itself. This repository uses Bun 1.3.11.

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

`packages/ts/README.md` must match the root `README.md`. Run `bun run readme:check` after editing either one.

Read `AGENTS.md` before making repository changes. Releases follow `docs/playbooks/release.md`.
