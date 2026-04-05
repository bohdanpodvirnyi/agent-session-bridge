# Contributing

## Setup

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

## Workflow

Use the red-green-refactor loop described in [TESTING.md](./TESTING.md).

Before opening a PR:

```bash
pnpm release:check
pnpm fixture:validate
pnpm exec prettier --check .
```

## Project Layout

- `packages/core`: canonical parsing, conversion, registry, sync, and safety logic
- `packages/cli`: local command surface
- `packages/pi`: Pi integration surface
- `packages/claude-code`: Claude Code integration surface
- `packages/codex`: Codex integration surface
- `packages/daemon`: optional backfill and repair helpers

## Scope Notes

- Keep new behavior covered by automated tests.
- Prefer adding sanitized fixtures instead of mock-heavy tests when format behavior matters.
- Do not mark live-runtime validation done unless it has been verified in the actual external tool.
