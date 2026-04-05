import { join } from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  extractMessageEntries,
  flattenPiActiveBranch,
  readClaudeCodeSession,
  readCodexRollout,
  readPiSession,
} from "../src/index.js";

const fixturesDir = join(import.meta.dirname, "fixtures");

describe("session parsers", () => {
  it("reads a Pi session and flattens the active branch", async () => {
    const session = await readPiSession(join(fixturesDir, "pi-session.jsonl"));

    expect(session.header.cwd).toBe("/repo/demo");
    expect(flattenPiActiveBranch(session).map((entry) => entry.id)).toEqual([
      "aaaa1111",
      "bbbb2222",
      "cccc3333",
    ]);
    expect(extractMessageEntries(session.entries)).toHaveLength(3);
  });

  it("reads a Claude Code session", async () => {
    const lines = await readClaudeCodeSession(
      join(fixturesDir, "claude-session.jsonl"),
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]?.type).toBe("assistant");
  });

  it("tolerates unknown JSONL line types without failing the whole parse", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "asb-unknown-"));
    const unknownPath = join(tempDir, "unknown-claude.jsonl");
    await writeFile(
      unknownPath,
      `${JSON.stringify({ type: "mystery", value: true })}\n${JSON.stringify({
        type: "assistant",
        uuid: "known",
      })}\n`,
    );

    const lines = await readClaudeCodeSession(unknownPath);
    expect(lines.map((line) => line.type)).toEqual(["mystery", "assistant"]);
  });

  it("reads plain and compressed Codex rollouts", async () => {
    const rolloutPath = join(fixturesDir, "codex-rollout.jsonl");
    const rollout = await readCodexRollout(rolloutPath);
    expect(rollout).toHaveLength(4);

    const raw = await readFile(rolloutPath);
    const tempDir = await mkdtemp(join(tmpdir(), "asb-zstd-"));
    const compressedPath = join(tempDir, "codex-rollout.jsonl.zst");
    await writeFile(compressedPath, zstdCompressSync(raw));

    const compressed = await readCodexRollout(compressedPath);
    expect(compressed).toHaveLength(4);
    expect(compressed[0]?.type).toBe("session_meta");
  });
});
