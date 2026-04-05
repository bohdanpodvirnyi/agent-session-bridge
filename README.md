# Agent Session Bridge

Agent Session Bridge mirrors resumable local agent sessions between Pi, Claude Code, and Codex.

## Status

This repository is in active development.

- Local parsing, conversion, sync, registry, CLI, and temp-folder end-to-end tests are implemented.
- Real live-runtime validation inside the actual external tools is still partially outstanding, especially for Codex resume behavior.
- The project is ready to share as a public repository, but not yet a polished one-command installer.

## What It Does

The bridge is designed to:

- read native session data from Pi, Claude Code, and Codex
- normalize conversation history into a shared internal model
- write mirror sessions into the other tools' local session formats
- track mirror relationships and replay safety through a local registry
- support CLI, hook, extension, and daemon-style integration surfaces

## Packages

- `packages/core`: parsing, conversion, registry, dedupe, sync, config, and safety helpers
- `packages/cli`: setup, list, import, link, repair, and audit commands
- `packages/pi`: Pi integration surface
- `packages/claude-code`: Claude Code integration surface
- `packages/codex`: Codex integration surface
- `packages/daemon`: optional backfill and repair helpers

## Quick Start

```bash
git clone <your-repo-url> agent-session-bridge
cd agent-session-bridge

pnpm install
pnpm build
node packages/cli/dist/cli/src/index.js setup
node packages/cli/dist/cli/src/index.js doctor
```

The friendly CLI flow is:

```bash
node packages/cli/dist/cli/src/index.js setup
node packages/cli/dist/cli/src/index.js enable
node packages/cli/dist/cli/src/index.js doctor
node packages/cli/dist/cli/src/index.js repair
```

What these commands do:

- `setup`: installs the Pi package registration, Claude Code hooks, Codex hooks, and writes bridge config for the current project
- `enable`: enables sync for the current project without reinstalling integrations
- `doctor`: shows whether Pi / Claude Code / Codex are wired correctly and whether hooks have run recently
- `repair`: fixes imported Pi session issues such as bad titles, bridge/bootstrap junk, raw directive lines, and missing assistant usage fields

Run the built CLI directly:

```bash
node packages/cli/dist/cli/src/index.js list
node packages/cli/dist/cli/src/index.js audit
```

## Configuration

Bridge config lives at `~/.agent-session-bridge/config.json`.

Fields:

- `optIn`: master on/off switch for sync. If `false`, no project syncs.
- `enabledProjects`: project allowlist. If this array is empty and `optIn` is `true`, all projects are enabled unless explicitly blocked.
- `disabledProjects`: project denylist. These paths always win over `enabledProjects`.
- `directions`: per-tool sync controls such as `codex->pi` or `claude->codex`.
- `redactionPatterns`: regex patterns applied before content is mirrored into another tool's local store.

Important behavior:

- `setup` enables sync for the current working directory by default.
- `setup --global` or `enable --global` switches to global mode by leaving `enabledProjects` empty.
- If `optIn` is `true` and `enabledProjects` is empty, all projects are enabled unless explicitly blocked.
- If `enabledProjects` is non-empty, only those exact project paths will sync.

Global mode example:

```json
{
  "optIn": true,
  "enabledProjects": [],
  "disabledProjects": [],
  "directions": {
    "pi->pi": false,
    "pi->claude": true,
    "pi->codex": true,
    "claude->pi": true,
    "claude->claude": false,
    "claude->codex": true,
    "codex->pi": true,
    "codex->claude": true,
    "codex->codex": false
  },
  "redactionPatterns": [
    { "source": "sk-[a-z0-9]+", "flags": "giu" },
    { "source": "api[_-]?key\\s*[:=]\\s*\\S+", "flags": "giu" }
  ]
}
```

Project allowlist example:

```json
{
  "optIn": true,
  "enabledProjects": [
    "/Users/example/projects/app-one",
    "/Users/example/projects/app-two"
  ],
  "disabledProjects": [],
  "directions": {
    "pi->pi": false,
    "pi->claude": true,
    "pi->codex": true,
    "claude->pi": true,
    "claude->claude": false,
    "claude->codex": true,
    "codex->pi": true,
    "codex->claude": true,
    "codex->codex": false
  },
  "redactionPatterns": [
    { "source": "sk-[a-z0-9]+", "flags": "giu" },
    { "source": "api[_-]?key\\s*[:=]\\s*\\S+", "flags": "giu" }
  ]
}
```

Direction keys:

- `pi->claude`
- `pi->codex`
- `claude->pi`
- `claude->codex`
- `codex->pi`
- `codex->claude`

The `x->x` keys are present for completeness and should stay `false`.

## Development

```bash
pnpm test
pnpm typecheck
pnpm fixture:validate
pnpm exec prettier --check .
```

## Documentation

- [TESTING.md](./TESTING.md): test workflow
- [docs/HOOKS.md](./docs/HOOKS.md): hook and extension notes
- [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md): debugging and repair notes
- [CONTRIBUTING.md](./CONTRIBUTING.md): contribution workflow

## Current Limitations

- External-tool installation is now guided by `setup`, but still assumes local access to the cloned repo and built workspace packages.
- Multiple independent chats in the same folder are not yet guaranteed to stay separated across every tool.
- Some imported legacy Codex tool-call history can still emit orphan-output warnings during resume.
- The repository is better described as "public alpha" than "finished product."
