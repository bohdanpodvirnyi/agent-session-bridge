# Troubleshooting

## Sessions are duplicated

- Run `agent-session-bridge audit` to inspect mirror mappings and watermarks.
- Run `agent-session-bridge repair <bridgeSessionId>` to mark a conversation for reconciliation.
- Confirm the same project resolves to the same `projectKey` and is not opened through mismatched paths.

## Imported sessions do not appear where expected

- Verify the target tool's native session directory exists.
- Re-run `agent-session-bridge import --latest`.
- Confirm the bridge registry links the expected native session ids.

## A hook fails during sync

- Hook handlers are designed to fail open.
- Inspect debug output with `agent-session-bridge audit`.
- Re-run one-shot backfill if a mirror fell behind.
