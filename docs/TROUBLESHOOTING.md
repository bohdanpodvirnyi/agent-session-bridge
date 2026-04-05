# Troubleshooting

## Sessions are duplicated

- Run `agent-session-bridge audit` to inspect mirror mappings and watermarks.
- Run `agent-session-bridge repair <bridgeSessionId>` to mark a conversation for reconciliation.
- Confirm the same project resolves to the same `projectKey` and is not opened through mismatched paths.

## Imported sessions do not appear where expected

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
- Inspect debug output with `agent-session-bridge audit`.
- Re-run one-shot backfill if a mirror fell behind.
