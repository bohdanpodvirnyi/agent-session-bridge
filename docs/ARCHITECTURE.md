# Architecture

`agent-session-bridge` is a local-first bridge between three native session stores:

- Pi
- Claude Code
- Codex

## Layers

### `packages/core`

Shared logic for:

- reading native session files
- normalizing messages
- converting between tool formats
- tracking mirror relationships
- replay protection and repair helpers

### `packages/cli`

User-facing commands:

- `setup`
- `enable`
- `doctor` for read-only health and registry-link inspection
- `repair` for cleanup of already-imported Pi and Claude mirror files
- `import` for one-shot backfill into target tools
- `audit`

This package also installs runtime assets into `~/.agent-session-bridge/runtime`.

### `packages/pi`

Pi-facing integration:

- session start import
- message-end sync
- bridge state persistence inside Pi session data

### `packages/claude-code`

Claude Code-facing integration:

- `SessionStart` hook support
- `Stop` hook support
- transcript import and sync helpers

### `packages/codex`

Codex-facing integration:

- `SessionStart` hook support
- `Stop` hook support
- rollout discovery, import, and sync helpers

### `packages/daemon`

Optional backfill-oriented helpers for:

- one-shot catch-up
- filesystem-driven repair or sync workflows

## Runtime Layout

The bridge keeps local runtime state under:

```text
~/.agent-session-bridge/
  config.json
  registry.json
  claude-code-hooks/
  codex-hooks/
  runtime/
    packages/
      pi/
      claude-code/
      codex/
```

## Session Strategy

The bridge does not maintain a synthetic universal transcript as the source of truth.

Instead it:

1. reads the native source transcript
2. converts the unread tail
3. writes native-compatible mirror entries to the targets
4. stores replay offsets in the registry

That keeps resume behavior aligned with how each tool already expects to load sessions.
