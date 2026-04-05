# Hook Installation Notes

## Claude Code

Use `packages/claude-code` as the command target for `SessionStart` and `Stop` hooks. The integration layer is intentionally thin and delegates registry and sync behavior to `packages/core`.

## Codex

Use `packages/codex` behind an experimental flag until real local resumability validation is complete.

## Pi

Use `packages/pi` as the extension surface. Mirror creation and recovery behavior are implemented in the shared core helpers and exposed through the integration package.

## Config Gating

All hook-driven sync is gated by `~/.agent-session-bridge/config.json`.

- `optIn: false` disables sync everywhere.
- `optIn: true` with `enabledProjects: []` enables sync for all projects.
- `optIn: true` with a non-empty `enabledProjects` array enables only those exact projects.
- `disabledProjects` always blocks a project even if it is listed in `enabledProjects`.

If hooks fire but no mirror sessions appear, check config gating before debugging the hook payloads themselves.
