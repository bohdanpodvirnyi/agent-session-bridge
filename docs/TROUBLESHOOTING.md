# Troubleshooting

## What the main commands do

- `agent-session-bridge doctor` is a read-only health check. It verifies bridge config, integration install state, recent Claude/Codex hook state, and how many bridge registry conversations are linked to the current project.
- `doctor` does not scan all raw session files on disk. The `Registry: N conversations` line is counting bridge registry entries for the project.
- `agent-session-bridge repair` rewrites already-existing mirrored Pi and Claude session files for the current project when imported history needs cleanup.
- `repair` does not backfill old sessions, discover missing sessions, or create new bridge links.
- `agent-session-bridge import --latest` imports one selected foreign-session candidate into the chosen target tool.
- `agent-session-bridge import --all` is the one-shot backfill command for importing all foreign-session candidates for the current project.

## Sessions are duplicated

- Run `agent-session-bridge audit` to inspect mirror mappings and watermarks.
- Run `agent-session-bridge repair --cwd /path/to/project` to clean already-imported Pi or Claude session files for the current project.
- Confirm the same project resolves to the same `projectKey` and is not opened through mismatched paths.

## Imported sessions do not appear where expected

- Run `agent-session-bridge doctor --cwd /path/to/project` first.
- Remember that `doctor` reports bridge registry links, not every raw session file on disk.
- Verify the target tool's native session directory exists.
- Run `agent-session-bridge import --all --tool <target>` to backfill older sessions into a target tool.
- Use `agent-session-bridge import --latest --tool <target>` when you only want the single best candidate instead of a full backfill.
- Confirm the bridge registry links the expected native session ids.
- Check `~/.agent-session-bridge/config.json`.
- If `optIn` is `true` and `enabledProjects` is empty, all projects are enabled by default.
- If `enabledProjects` is non-empty, parent paths also enable nested projects below them.
- `disabledProjects` always overrides `enabledProjects`.
- If Codex has chats for a folder but Pi shows no sessions there, the most common cause is that the folder is not enabled in config.

## A hook fails during sync

- Hook handlers are designed to fail open.
- Inspect debug output with `agent-session-bridge audit` and `agent-session-bridge doctor`.
- Re-run `agent-session-bridge import --all --tool <target>` if a mirror fell behind and needs a one-shot backfill.

## Pi resume titles look wrong

- Run `agent-session-bridge repair --cwd /path/to/project`.
- The repair command removes imported bootstrap/system prompts, strips raw Codex desktop directive lines like `::git-push{...}`, normalizes assistant metadata, and re-chains Pi session parents when needed.
