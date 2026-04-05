import { describe, expect, it } from "vitest";

import {
  emptyRegistry,
  findConversationByBridgeSessionId,
  loadRegistry,
  markConversationConflicted,
  reconcileWatermarks,
  setRepairState,
  upsertConversation,
  validateRegistryShape,
  type BridgeConversation,
  type FileSystemLike,
} from "../src/index.js";

function makeConversation(): BridgeConversation {
  return {
    bridgeSessionId: "bridge-1",
    projectKey: "/repo/demo",
    canonicalCwd: "/repo/demo",
    createdAt: "2026-04-05T10:00:00.000Z",
    updatedAt: "2026-04-05T10:00:00.000Z",
    status: "active",
    mirrors: {},
    lastWrittenOffsets: [],
  };
}

describe("extended registry helpers", () => {
  it("rejects invalid registry files", async () => {
    const fs = {
      async readFile() {
        return JSON.stringify({ version: 999, conversations: [] });
      },
    } satisfies Pick<FileSystemLike, "readFile">;

    await expect(loadRegistry("/tmp/registry.json", fs)).rejects.toThrow(
      "Invalid registry shape",
    );
    expect(() =>
      validateRegistryShape({ version: 1, conversations: [] }),
    ).not.toThrow();
  });

  it("finds a conversation by bridge session id", () => {
    const registry = upsertConversation(emptyRegistry(), makeConversation());
    expect(
      findConversationByBridgeSessionId(registry, "bridge-1")?.projectKey,
    ).toBe("/repo/demo");
  });

  it("marks a conversation as conflicted and requests repair", () => {
    const conflicted = markConversationConflicted(
      makeConversation(),
      "simultaneous writers detected",
      "2026-04-05T11:00:00.000Z",
    );

    expect(conflicted.status).toBe("conflicted");
    expect(conflicted.repair).toEqual({
      status: "needed",
      reason: "simultaneous writers detected",
      updatedAt: "2026-04-05T11:00:00.000Z",
    });
  });

  it("updates repair state without disturbing the conversation identity", () => {
    const updated = setRepairState(makeConversation(), {
      status: "running",
      reason: "repairing mirror offsets",
      updatedAt: "2026-04-05T12:00:00.000Z",
    });

    expect(updated.bridgeSessionId).toBe("bridge-1");
    expect(updated.repair?.status).toBe("running");
  });

  it("reconciles stale watermark duplicates by keeping the highest target offset", () => {
    const watermarks = reconcileWatermarks([
      {
        sourceTool: "claude",
        sourceSessionId: "c1",
        sourceOffset: 3,
        targetTool: "pi",
        targetSessionId: "p1",
        targetOffset: 5,
        contentHash: "hash-1",
      },
      {
        sourceTool: "claude",
        sourceSessionId: "c1",
        sourceOffset: 3,
        targetTool: "pi",
        targetSessionId: "p1",
        targetOffset: 7,
        contentHash: "hash-1",
      },
    ]);

    expect(watermarks).toHaveLength(1);
    expect(watermarks[0]?.targetOffset).toBe(7);
  });
});
