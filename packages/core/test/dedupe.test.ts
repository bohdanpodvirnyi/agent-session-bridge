import { describe, expect, it } from "vitest";

import {
  applySyncDecision,
  decideSyncChunk,
  hashSyncContent,
} from "../src/index.js";

describe("dedupe and reconciliation", () => {
  it("accepts a new sync chunk and records a watermark", () => {
    const decision = decideSyncChunk([], {
      sourceTool: "claude",
      sourceSessionId: "c1",
      sourceOffset: 10,
      targetTool: "pi",
      targetSessionId: "p1",
      targetOffset: 5,
      content: "assistant line",
    });

    expect(decision.apply).toBe(true);
    expect(applySyncDecision([], decision)).toHaveLength(1);
  });

  it("suppresses duplicate replay with the same content hash", () => {
    const existing = [
      {
        sourceTool: "claude" as const,
        sourceSessionId: "c1",
        sourceOffset: 10,
        targetTool: "pi" as const,
        targetSessionId: "p1",
        targetOffset: 5,
        contentHash: hashSyncContent("assistant line"),
      },
    ];

    const decision = decideSyncChunk(existing, {
      sourceTool: "claude",
      sourceSessionId: "c1",
      sourceOffset: 10,
      targetTool: "pi",
      targetSessionId: "p1",
      targetOffset: 5,
      content: "assistant line",
    });

    expect(decision).toMatchObject({ apply: false, reason: "duplicate" });
  });

  it("rejects stale target offsets from restarted processes", () => {
    const existing = [
      {
        sourceTool: "claude" as const,
        sourceSessionId: "c1",
        sourceOffset: 10,
        targetTool: "pi" as const,
        targetSessionId: "p1",
        targetOffset: 7,
        contentHash: hashSyncContent("assistant line v2"),
      },
    ];

    const decision = decideSyncChunk(existing, {
      sourceTool: "claude",
      sourceSessionId: "c1",
      sourceOffset: 11,
      targetTool: "pi",
      targetSessionId: "p1",
      targetOffset: 5,
      content: "assistant line v3",
    });

    expect(decision).toMatchObject({ apply: false, reason: "stale-target" });
  });
});
