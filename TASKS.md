# Agent Session Bridge Tasks

Status key:

- `[x]` done in this repo with code and automated checks
- `[~]` partially implemented or scaffolded, but not yet a working end-to-end runtime path
- `[ ]` not yet implemented or not yet proven in a real external tool runtime

Validation note:

- Local implementation, tests, lint, typecheck, fixture validation, formatting, and build checks cover the shared core well.
- Several integration-package and CLI items were previously marked complete even though they are still thin scaffolds or placeholders.
- The remaining partial and unchecked items now include both missing runtime behavior and missing live-tool validation in actual Pi, Claude Code, or Codex sessions.

## TDD Workflow

- [x] Write or expand tests first.
- [x] Run the tests and confirm the new cases fail for the expected reason.
- [x] Implement the smallest change that makes those tests pass.
- [x] Refactor only after the test suite is green.
- [x] Preserve fixtures and regression tests for every bug found during development.

Preferred order of work:

- [x] domain model and registry
- [x] project identity and path normalization
- [x] dedupe and reconciliation
- [x] parsers
- [x] converters
- [x] Pi <-> Claude integration
- [x] CLI and repair flows
- [x] Codex behind an experimental flag

## Phase 0: Project Setup

- [x] Initialize the repository structure for `agent-session-bridge`.
- [x] Set up a TypeScript workspace for `core`, `cli`, `pi`, `claude-code`, `codex`, and `daemon`.
- [x] Configure shared tooling for TypeScript, Vitest, ESLint, and Prettier.
- [x] Add package scripts for build, test, typecheck, lint, format, fixture validation, and release checks.
- [x] Create a local development README with install and test instructions.
- [x] Add a testing guide that documents the red-green-refactor workflow.

## Phase 1: Core Domain Model

- [x] Write and pass tests for registry defaults, lookup by `projectKey`, lookup by native session id, upsert behavior, and conversation state helpers.
- [x] Define `BridgeConversation`, registry, conflict, repair, sync-watermark, and related core types.
- [x] Add versioning for registry/state files.
- [x] Refactor core types and helpers after the first registry tests were green.

## Phase 2: Project Identity and Path Utilities

- [x] Write and pass tests for `realpath` normalization, repo-root `projectKey`, non-repo fallback behavior, and symlink equivalence.
- [x] Implement path normalization helpers.
- [x] Implement `realpath`-based cwd normalization.
- [x] Implement git repo root detection.
- [x] Implement `projectKey` derivation.
- [x] Implement native directory helpers for Pi, Claude Code, and Codex session storage.

## Phase 3: Registry and State Management

- [x] Write and pass tests for missing registry load, invalid registry rejection, atomic save behavior, stale watermark reconciliation, and conflict marking.
- [x] Implement registry load/save helpers.
- [x] Implement atomic registry writes.
- [x] Implement per-conversation state helpers.
- [x] Implement lock handling for concurrent hook execution.
- [x] Implement mirror lookup by `bridgeSessionId`, `projectKey`, and native session id.
- [x] Implement conflict marking and reconciliation helpers.
- [x] Add tests for state loss, partial replay protection, and conflict transitions.

## Phase 4: Native Session Parsers

- [x] Add sanitized fixture files for Pi, Claude Code, and Codex.
- [x] Write and pass parser tests for valid session headers, recognized line types, unknown line tolerance, active-branch flattening in Pi, and compressed Codex rollout handling.
- [x] Implement Pi session reader.
- [x] Implement Claude Code session reader.
- [x] Implement Codex rollout reader with compressed-file support.
- [x] Implement safe handling of unknown JSONL line types.
- [x] Implement Pi active-branch flattening.
- [x] Implement message-entry extraction helpers.
- [x] Refactor parser internals after fixture-based tests were green.

## Phase 5: Shared Conversion Layer

- [x] Define an internal normalized message model.
- [x] Write and pass conversion tests for Pi, Claude, Codex, and unsupported-content degradation.
- [x] Implement Pi -> normalized conversion.
- [x] Implement Claude -> normalized conversion.
- [x] Implement Codex -> normalized conversion.
- [x] Implement normalized -> Pi conversion.
- [x] Implement normalized -> Claude conversion.
- [x] Implement normalized -> Codex conversion.
- [x] Preserve structured text, images, tool calls, tool results, and representable thinking blocks.
- [x] Pair tool call/result ids without guessing when a source id exists.
- [x] Add degradation-safe fallback behavior and supporting audit-log helpers.
- [x] Refactor the converter surface after the round-trip tests were green.

## Phase 6: Deduplication and Reconciliation

- [x] Write and pass tests for repeated `Stop` hook runs, missing-state replay protection, hash-based duplicate suppression, stale target offsets, and restarted hook processes.
- [x] Implement per-direction source offset tracking.
- [x] Implement content hashing for converted chunks.
- [x] Implement target watermark/stale-target protection.
- [x] Implement replay-safe reconciliation.
- [x] Implement duplicate detection for repeated runs and restored state.
- [x] Add tests that protect against transcript ping-pong growth.
- [x] Refactor dedupe internals after replay-safety tests were green.

## Phase 7: Pi <-> Claude MVP

- [x] Write and pass integration tests for Pi -> Claude sync, Claude -> Pi sync, latest-session import selection, and linked resume-candidate selection.
- [x] Implement first-time import selection with linked-session preference and latest-session fallback.
- [x] Implement Pi -> Claude append conversion logic.
- [x] Implement Claude -> Pi append conversion logic.
- [x] Implement mirror registration helpers and ownership-friendly sync helpers.
- [x] Add end-to-end-style sync tests for switching between tools without duplication.
- [x] Refactor MVP sync flows after cross-tool tests were green.

## Phase 8: Pi Extension

- [x] Write extension-focused tests for `session_start`, `message_end`, and reload-state serialization.
- [x] Scaffold the Pi extension package.
- [x] Implement `session_start` handling.
- [x] Implement `message_end` handling.
- [x] Load or create linked bridge state on session start.
- [x] Add bridge-state serialization for reload recovery.
- [x] Create or discover target Claude/Codex mirror sessions from the Pi extension.
- [x] Append converted Pi messages to Claude mirror files during live Pi runs.
- [x] Append converted Pi messages to Codex mirror files during live Pi runs.
- [x] Persist and reuse per-direction sync watermarks from live Pi extension runs.
- [x] Verify the installed Pi extension creates real mirror files in an external Pi session.
- [x] Add local extension development notes through project docs.

## Phase 9: Claude Hooks

- [x] Write hook-focused tests for `SessionStart` import selection, `Stop` conflict handling, and stdin payload parsing.
- [x] Scaffold `SessionStart` and `Stop` hook handler surfaces.
- [x] Parse Claude hook stdin payload.
- [x] Implement project lookup and linked-session resume selection on `SessionStart`.
- [x] Build an executable Claude hook entrypoint that can be installed in Claude Code.
- [x] Implement latest-foreign-session import selection on first open.
- [x] Implement incremental transcript handling on `Stop`.
- [x] Add non-blocking conflict/error behavior.
- [x] Read Claude transcripts from `transcript_path` and convert new lines during live runs.
- [x] Write converted Claude history into Pi session files during live runs.
- [x] Write converted Claude history into Codex rollout files during live runs.
- [x] Persist Claude hook state and watermarks under `~/.agent-session-bridge/`.
- [x] Verify the installed Claude hook creates real mirror files in an external Claude Code session.
- [x] Add hook installation notes in docs.

## Phase 10: CLI and Repair Tools

- [x] Write CLI tests for `setup`, `list`, `import`, `link`, `repair`, `audit`, and dry-run behavior.
- [x] Scaffold the CLI package.
- [x] Implement `agent-session-bridge setup`.
- [x] Implement `agent-session-bridge list`.
- [x] Implement `agent-session-bridge import --latest`.
- [x] Implement `agent-session-bridge import --all`.
- [x] Implement `agent-session-bridge link`.
- [x] Implement `agent-session-bridge repair <bridgeSessionId>`.
- [x] Implement `agent-session-bridge audit`.
- [x] Add dry-run support for non-destructive CLI flows.
- [x] Make `agent-session-bridge setup` actually install or update local Pi, Claude Code, and Codex integration files.
- [x] Make `agent-session-bridge import --latest` perform a real import into target session stores.
- [x] Make `agent-session-bridge import --all` perform real bulk imports into target session stores.
- [x] Add verification output so CLI install/import commands report what files were created or updated.

## Phase 11: Safety and Privacy Controls

- [x] Write tests for opt-in gating, per-project disablement, per-direction sync blocking, and secret redaction.
- [x] Add an explicit opt-in-aware default config.
- [x] Add per-project enable/disable configuration.
- [x] Add per-direction sync controls.
- [x] Add allowlist/denylist behavior for projects.
- [x] Add secret redaction hooks for common token patterns.
- [x] Add redacted audit-log helpers so logs are useful without exposing obvious secrets.

## Phase 12: Reliability and Failure Handling

- [x] Write tests for retry behavior, stale-lock recovery, and non-blocking mirror failures.
- [x] Implement append retry behavior for transient failures.
- [x] Ensure mirror-write failures can be captured without throwing into the caller.
- [x] Implement stale-lock recovery.
- [x] Surface conflict state through registry/audit data structures.
- [x] Add recovery-oriented tests to the core reliability layer.

## Phase 13: Distribution and Packaging

- [x] Add smoke tests for publishable package metadata.
- [x] Prepare `agent-session-bridge-core` for publishing.
- [x] Prepare the CLI package for global install.
- [x] Package the Pi extension for installation.
- [x] Create Claude/Codex/Pi hook install notes and troubleshooting docs.
- [x] Add release scripts and a release checklist.
- [x] Write user documentation for setup, repair, and troubleshooting.
- [x] Package a real Claude hook executable for installation.
- [x] Package a real Codex hook executable that performs mirror writes instead of only recording debug state.
- [~] Add a one-command local install path that produces working Pi and Codex integrations from a fresh checkout.

## Phase 14: Codex Experimental Track

- [x] Write experimental tests for rollout discovery, synthetic turn generation, Codex parsing, and Codex mirror registration.
- [x] Scaffold Codex hook scripts behind an experimental package boundary.
- [x] Parse Codex hook payloads.
- [x] Implement rollout discovery from hook context.
- [x] Implement Codex incremental rollout reading in the core parser layer.
- [x] Implement Pi/Claude -> Codex conversion with synthetic turn boundaries.
- [x] Implement Codex -> Pi conversion.
- [x] Implement Codex -> Claude conversion.
- [x] Add experimental mirror registration for Codex sessions.
- [x] Read the active Codex rollout from `transcript_path` during live `Stop` hook runs.
- [x] Compute per-direction deltas from live Codex rollouts instead of only logging hook payloads.
- [x] Write converted Codex history into Pi session files during live runs.
- [x] Write converted Codex history into Claude session files during live runs.
- [x] Create target Pi/Claude mirror files automatically on first Codex sync.
- [x] Persist Codex hook state and watermarks under `~/.agent-session-bridge/`.

## Phase 15: Codex Validation Gate

- [x] Add automated acceptance-style tests for Codex rollout structure and synthetic boundary behavior.
- [x] Prove imported synthetic rollouts appear in real `codex resume`.
- [x] Prove imported synthetic rollouts resume successfully in a real interactive Codex session.
- [x] Prove subsequent turns sync incrementally after a real Codex resume.
- [x] Prove duplicate prevention survives stopped and restarted real Codex hooks.
- [x] Prove rollout discovery is reliable enough across repeated live local runs.
- [x] Remove the experimental label only after the live Codex runtime validations pass.

## Phase 16: Optional Daemon

- [x] Write daemon tests for one-shot backfill, reconciliation reuse, and optional watch mode.
- [x] Implement one-shot backfill for existing sessions.
- [x] Implement optional watch mode for repair and catch-up scaffolding.
- [x] Reuse registry and reconciliation logic from the core layer.
- [x] Add docs explaining that the daemon is optional.

## Phase 17: Final Acceptance

- [x] Run the full fixture test suite.
- [x] Run end-to-end Pi <-> Claude acceptance-style tests in the local test suite.
- [x] Run state-loss and repair acceptance-style tests.
- [x] Run symlink/path-normalization acceptance tests.
- [x] Run privacy and config acceptance tests.
- [x] Complete live Pi extension validation in a real external Pi runtime.
- [x] Complete live Claude hook validation in a real external Claude Code runtime.
- [x] Complete the live Codex validation gate in a real external runtime.
- [x] Prepare a release checklist for v1.
- [x] Freeze fixtures and regression tests for the first public release.
