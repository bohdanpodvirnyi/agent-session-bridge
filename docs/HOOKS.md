# Hook Installation Notes

## Claude Code

Use `packages/claude-code` as the command target for `SessionStart` and `Stop` hooks. The integration layer is intentionally thin and delegates registry and sync behavior to `packages/core`.

## Codex

Use `packages/codex` behind an experimental flag until real local resumability validation is complete.

## Pi

Use `packages/pi` as the extension surface. Mirror creation and recovery behavior are implemented in the shared core helpers and exposed through the integration package.
