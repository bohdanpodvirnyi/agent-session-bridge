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

## Local Install

```bash
git clone <your-repo-url> agent-session-bridge
cd agent-session-bridge

pnpm install
pnpm build
pnpm release:check
```

Run the built CLI directly:

```bash
node packages/cli/dist/cli/src/index.js setup
node packages/cli/dist/cli/src/index.js list
node packages/cli/dist/cli/src/index.js audit
```

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

- Real external-tool installation is still manual.
- Some imported legacy Codex tool-call history can still emit orphan-output warnings during resume.
- The repository is better described as "public alpha" than "finished product."
