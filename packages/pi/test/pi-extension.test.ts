import { describe, expect, it } from "vitest";

import {
  handleMessageEnd,
  handleSessionStart,
  restorePiBridgeState,
  serializePiBridgeState,
} from "../src/index.js";

describe("pi extension", () => {
  it("attaches a Claude mirror on session start", () => {
    const conversation = handleSessionStart({
      bridgeConversation: {
        bridgeSessionId: "bridge-1",
        projectKey: "/repo/demo",
        canonicalCwd: "/repo/demo",
        createdAt: "2026-04-05T10:00:00.000Z",
        updatedAt: "2026-04-05T10:00:00.000Z",
        status: "active",
        mirrors: {},
        lastWrittenOffsets: [],
      },
      mirrorSessionId: "claude-1",
      mirrorPath: "/tmp/claude-1.jsonl",
      timestamp: "2026-04-05T10:01:00.000Z",
    });

    expect(conversation.mirrors.claude?.nativeId).toBe("claude-1");
  });

  it("passes message_end entries through for downstream conversion", () => {
    const entry = {
      type: "message",
      id: "1",
      message: { role: "user", content: "hello" },
    };
    expect(handleMessageEnd(entry).id).toBe("1");
  });

  it("serializes and restores bridge state for reload recovery", () => {
    const state = {
      mirrorSessionId: "claude-1",
      mirrorPath: "/tmp/claude-1.jsonl",
      updatedAt: "2026-04-05T10:01:00.000Z",
    };

    expect(restorePiBridgeState(serializePiBridgeState(state))).toEqual(state);
  });
});
