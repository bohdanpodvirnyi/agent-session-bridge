# Agent Session Bridge

[![CI](https://github.com/bohdanpodvirnyi/agent-session-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/bohdanpodvirnyi/agent-session-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Agent Session Bridge mirrors resumable local agent sessions between Pi, Claude Code, and Codex.

## Status

This repository is public and npm-distribution ready.

- Native format parsing, conversion, sync, registry, CLI, and repair flows are implemented.
- The repo includes both file-level end-to-end coverage and real-command E2E coverage against the actual Pi, Claude Code, and Codex CLIs.
- The package now supports install/setup from a packaged npm artifact and writes self-contained runtime assets into `~/.agent-session-bridge/runtime`.
- Long-lived messy sessions can still require `repair`, especially after older bridge versions.

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

Published npm flow:

```bash
npx agent-session-bridge setup
npx agent-session-bridge doctor
```

Until the first npm release is published, you can verify the exact same packaged flow locally with:

```bash
npm pack
npx --yes --package ./agent-session-bridge-0.0.0.tgz agent-session-bridge setup
```

Local checkout flow:

```bash
git clone https://github.com/bohdanpodvirnyi/agent-session-bridge.git
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
- If `enabledProjects` is non-empty, parent paths also enable nested projects beneath them.
- `disabledProjects` always overrides `enabledProjects`, including inherited parent-path matches.

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

- The npm package is distribution-ready, but it still needs a first public npm release before plain `npx agent-session-bridge ...` works without a tarball or install.
- Older imported transcripts can still need `repair` if they were created by earlier bridge versions.
- Some imported legacy Codex tool-call history can still emit orphan-output warnings during resume.
- Public API and package versioning are still early, so expect some installer and config changes as the project hardens.
