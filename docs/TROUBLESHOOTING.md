# Troubleshooting

## Sessions are duplicated

- Run `agent-session-bridge audit` to inspect mirror mappings and watermarks.
- Run `agent-session-bridge repair --cwd /path/to/project` to clean imported Pi sessions for the current project.
- Confirm the same project resolves to the same `projectKey` and is not opened through mismatched paths.

## Imported sessions do not appear where expected

- Run `agent-session-bridge doctor --cwd /path/to/project` first.
- Verify the target tool's native session directory exists.
- Re-run `agent-session-bridge import --latest`.
- Confirm the bridge registry links the expected native session ids.
- Check `~/.agent-session-bridge/config.json`.
- If `optIn` is `true` and `enabledProjects` is empty, all projects are enabled by default.
- If `enabledProjects` is non-empty, only those exact project paths will sync.
- `disabledProjects` always overrides `enabledProjects`.
- If Codex has chats for a folder but Pi shows no sessions there, the most common cause is that the folder is not enabled in config.

## A hook fails during sync

- Hook handlers are designed to fail open.
- Inspect debug output with `agent-session-bridge audit` and `agent-session-bridge doctor`.
- Re-run one-shot backfill if a mirror fell behind.

## Pi resume titles look wrong

- Run `agent-session-bridge repair --cwd /path/to/project`.
- The repair command removes imported bootstrap/system prompts, strips raw Codex desktop directive lines like `::git-push{...}`, and re-chains Pi session parents when needed.
