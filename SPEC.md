# Agent Session Bridge

## Project Specification v4.0

## 1. Goal

Agent Session Bridge makes local AI coding sessions portable between Pi, Claude Code, and Codex.

The core promise is:

1. Work in one tool.
2. Open another tool in the same project.
3. Resume the same conversation without manual conversion.

The bridge copies resumable local session history between tools. It does not attempt live multi-writer collaboration, concurrent merging, or provider-level reasoning continuity.

## 2. Product Principles

1. Portability over completeness. Preserve resumability first; preserve every tool-specific field only when safe.
2. Native hooks first. Use each tool's own lifecycle hooks or extension APIs before introducing a daemon.
3. One bridge conversation, many local mirrors. A single logical conversation may have one Pi session, one Claude session, and one Codex rollout attached to it.
4. Provenance is mandatory. The bridge must always know which tool originated each synced segment.
5. No silent fan-out. Automatic sync is opt-in and configurable per machine and per project.
6. Codex support is gated by validation, not assumed from format analysis alone.

## 3. Architecture

### 3.1 Primary Architecture

Each supported tool writes native session data as usual. A bridge plugin or hook observes session progress and appends converted entries to mirror sessions for the other tools.

```text
Active tool -> native session file
            -> bridge plugin/hook
            -> bridge registry/state
            -> mirror session files for other tools
```

### 3.2 Secondary Architecture

An optional daemon supports:

- one-shot backfill of old sessions
- repair after interrupted sync
- rehydration after reinstall

The daemon is not required for normal use.

## 4. Canonical Data Model

### 4.1 Bridge Conversation

The bridge introduces a canonical object called a `BridgeConversation`.

Each conversation has:

- `bridgeSessionId`: stable UUID generated once
- `projectKey`: normalized project identity
- `createdAt`
- `updatedAt`
- `status`: active, archived, or conflicted
- `toolSessions`: attached native sessions by tool

The bridge never treats `cwd` alone as the identity of a conversation.

### 4.2 Project Identity

Project matching uses:

1. normalized real path via `realpath`
2. repository root if inside a git repo
3. normalized path fallback when no repo is present

The derived `projectKey` is what import and discovery logic uses. Raw tool-specific cwd encodings are only storage details.

### 4.3 Bridge Registry

The bridge stores a local registry in `~/.agent-session-bridge/registry.json`.

Each registry entry contains:

- `bridgeSessionId`
- `projectKey`
- `canonicalCwd`
- `mirrors.pi.sessionPath`
- `mirrors.claude.sessionPath`
- `mirrors.codex.rolloutPath`
- `nativeIds.pi`
- `nativeIds.claude`
- `nativeIds.codex`
- `lastWrittenOffsets` per source->target direction
- `contentHashes` for dedupe checkpoints
- `lastOriginTool`

This registry is the source of truth for mirror relationships. Session files remain unmodified except for safe native writes.

## 5. Sync Model

### 5.1 Origin and Provenance

Every sync operation is tracked as:

- `sourceTool`
- `sourceSessionId`
- `sourceOffset`
- `targetTool`
- `targetSessionId`
- `targetOffset`
- `contentHash`

The bridge does not inject provenance markers into session transcripts unless a tool has a supported metadata channel for doing so safely.

### 5.2 Duplicate Prevention

Line counts alone are insufficient.

Duplicate prevention uses:

1. persisted source offsets per direction
2. stable mirror mapping via `bridgeSessionId`
3. content hashes for the converted chunk
4. target-side watermark confirmation after append

If state is missing or mismatched, the bridge replays in reconciliation mode and skips already-applied chunks by hash.

### 5.3 Ownership Model

There is no exclusive lock owner, but there is one active origin at a time for normal operation.

The registry tracks `lastOriginTool` and `updatedAt`.

Rules:

1. If only one tool is active, sync normally.
2. If a different tool becomes active later, ownership shifts naturally after the next native write.
3. If multiple tools write concurrently to different sessions for the same `bridgeSessionId`, mark the conversation `conflicted` and stop automatic merging.

Concurrent merge is out of scope for v1.

## 6. Import and Resume Policy

### 6.1 First-Time Project Open

When a tool opens a project and no registry entry exists, the bridge may discover zero or more foreign sessions for the same `projectKey`.

Selection policy:

1. Prefer an already-linked mirror in the registry.
2. Otherwise choose the most recently updated foreign session.
3. Do not import all matching sessions automatically.
4. Record the chosen foreign session as the initial mirror for the new `bridgeSessionId`.

Additional matching sessions may be exposed later via CLI import commands, but they are not auto-materialized into the active tool.

### 6.2 Resume Behavior

Once a registry entry exists, `SessionStart` must continue the linked bridge conversation for that project unless the user explicitly starts a new one.

This avoids the "many old sessions for the same cwd" problem.

### 6.3 Manual Controls

The CLI must support:

- `agent-session-bridge list`
- `agent-session-bridge link <source-session> <target-session>`
- `agent-session-bridge import --latest`
- `agent-session-bridge import --all`
- `agent-session-bridge repair <bridgeSessionId>`

## 7. Tool Support Strategy

### 7.1 Phase 1: Pi <-> Claude Code

This is the first production target because both are JSONL-based and Anthropic-shaped.

Supported in v1:

- user messages
- assistant text
- tool calls
- tool results
- compaction summaries as plain text

Not preserved in v1:

- Pi alternate branches
- Claude file-history snapshots
- opaque thinking continuity tokens

### 7.2 Phase 2: Codex

Codex support is validated.

Phase 2 exits design-only status only after all of the following are proven with fixtures and local resume tests:

1. a synthetic imported rollout appears in `codex resume`
2. the rollout can actually resume, not merely parse
3. synthetic turn boundaries are sufficient for reconstruction
4. rollout discovery from hook context is reliable enough for incremental sync

Those proofs now exist in automated checks and real local resume validation, so Codex is no longer labeled experimental.

## 8. Format Handling Rules

### 8.1 Pi

Use Pi's native session header and tree entries, but convert only the currently active branch. Flattening is explicit and documented.

### 8.2 Claude Code

Parse only recognized entry types. Ignore unknown lines safely.

The bridge does not depend on undocumented Claude metadata files for correctness. If picker visibility requires indexing behavior, that must be validated as part of UX acceptance.

### 8.3 Codex

Treat Codex rollouts as append-only event streams. Handle compressed and uncompressed files. Do not assume undocumented invariants beyond what fixture-based tests verify.

## 9. Content Conversion Rules

### 9.1 Rich Content

The converter must preserve structured content whenever the target format supports it.

Supported content classes:

- text
- images
- tool calls
- tool results
- thinking blocks when representable

If a target cannot represent a content item faithfully, the converter must:

1. degrade it explicitly
2. record the degradation in debug logs
3. keep the surrounding message resumable

### 9.2 Tool Result Fidelity

Tool results must not rely on inferred tool names when a source identifier is available.

The registry may maintain a short-lived call map per conversation so outputs can be paired with prior tool calls without guessing.

### 9.3 Usage and Stop Reasons

Usage and stop-reason fields are best-effort metadata only. They must never be required for successful resume.

## 10. Safety and Privacy

Automatic sync copies prompts, outputs, and tool results into other vendors' local storage locations.

Therefore v1 requires:

- explicit opt-in during setup
- per-project allowlist or denylist support
- ability to disable any tool pair direction
- optional secret redaction hooks for known patterns
- a dry-run mode for inspection

The setup flow must describe clearly which local directories will receive mirrored data.

## 11. Components

### 11.1 Core Library

Package: `agent-session-bridge-core`

Responsibilities:

- session parsing
- project normalization
- conversion
- registry access
- dedupe and reconciliation
- fixture-driven validation

### 11.2 Pi Extension

Responsibilities:

- observe native session events
- create or continue linked bridge conversations
- append mirrors for Claude and Codex
- persist enough native bridge state to recover after extension reload if Pi supports safe custom entries

### 11.3 Claude Hooks

Responsibilities:

- `SessionStart`: attach to linked bridge conversation or import latest foreign session
- `Stop`: incremental sync from transcript to mirrors
- read and update registry state

### 11.4 Codex Hooks

Responsibilities:

- same high-level responsibilities as Claude hooks
- additional rollout discovery and turn-boundary validation

### 11.5 Optional Daemon

Responsibilities:

- backfill
- repair
- audit

Not responsible for core real-time sync.

## 12. Storage Layout

Bridge-owned files live under `~/.agent-session-bridge/`:

- `registry.json`
- `state/`
- `logs/`
- `locks/`

Tool-owned session files remain in native directories:

- Pi: `~/.pi/agent/sessions/...`
- Claude Code: `~/.claude/projects/...`
- Codex: `~/.codex/sessions/...`

## 13. Failure Handling

If sync to one target fails:

1. do not block the source tool
2. record the failed chunk in bridge logs
3. leave the registry consistent
4. retry via next hook or daemon repair

If mirror identity becomes ambiguous:

1. stop automatic append
2. mark the conversation `conflicted`
3. require explicit repair or relink

## 14. Testing Requirements

### 14.1 Fixture Tests

Use real-world sanitized fixtures from all supported tools.

Required tests:

- parse native sessions
- convert each supported message shape
- round-trip stability where feasible
- duplicate replay prevention
- import-selection behavior
- state-loss reconciliation

### 14.2 Integration Tests

Required scenarios:

1. start in Pi, resume in Claude
2. start in Claude, resume in Pi
3. reinstall bridge, recover from registry only
4. delete bridge state, reconcile without duplicate transcript growth
5. symlinked repo path still matches same `projectKey`

### 14.3 Codex Acceptance Tests

Required for Codex validation:

1. imported rollout is listed
2. imported rollout resumes successfully
3. subsequent turns sync incrementally
4. duplicate prevention survives a stopped and restarted hook process

## 15. Implementation Plan

### Step 1

Build `agent-session-bridge-core` with:

- project normalization
- registry
- converters for Pi and Claude
- reconciliation logic
- fixture tests

### Step 2

Ship Pi <-> Claude support with:

- Pi extension
- Claude `SessionStart`
- Claude `Stop`
- setup CLI

### Step 3

Add CLI repair and audit commands.

### Step 4

Validate Codex support against real resume behavior and keep it aligned with native rollout expectations.

### Step 5

Add optional daemon for backfill and repair.

## 16. Non-Goals

v1 does not attempt:

- merging concurrent sessions from multiple active tools
- transferring provider-private reasoning continuity
- preserving every tool-specific metadata field
- maintaining undocumented UI index files unless required and validated

## 17. Success Criteria

The project is successful when:

1. a user can move between Pi and Claude in the same repo and continue one linked conversation
2. bridge state loss does not create transcript ping-pong or unbounded duplication
3. old sessions for the same repo do not flood the target tool's resume list
4. Codex resumes imported bridge sessions reliably enough to be treated as a supported path
