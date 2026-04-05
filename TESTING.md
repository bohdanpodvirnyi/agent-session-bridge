# Testing Guide

## Workflow

Use red-green-refactor for every task:

1. Add or extend a failing test.
2. Run the smallest relevant test target and confirm the failure is expected.
3. Implement the minimum change required to pass.
4. Run the broader suite.
5. Refactor only while the suite stays green.

## Commands

```bash
pnpm test
pnpm test:watch
pnpm typecheck
pnpm fixture:validate
pnpm lint
pnpm format
```

## Regression Policy

- Keep sanitized fixtures under `packages/core/test/fixtures`.
- Add a regression test for every bug fixed in parsing, conversion, or dedupe behavior.
- Do not mark checklist items done unless tests cover the behavior.
