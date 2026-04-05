import { describe, expect, it } from "vitest";

import {
  attachMirror,
  chooseResumeCandidate,
  convertConversationToCodexRollout,
  syncClaudeSessionToPi,
  syncPiSessionToClaude,
  type BridgeConversation,
  type NormalizedMessage,
  type PiSession,
} from "../src/index.js";

describe("sync helpers", () => {
  it("syncs a Pi session into Claude lines", () => {
    const session: PiSession = {
      header: {
        type: "session",
        version: 3,
        id: "pi-session",
        timestamp: "2026-04-05T10:00:00.000Z",
        cwd: "/repo/demo",
      },
      entries: [
        {
          type: "message",
          id: "1",
          parentId: null,
          timestamp: "2026-04-05T10:00:01.000Z",
          message: {
            role: "user",
            content: "hello",
          },
        },
      ],
    };

    const lines = syncPiSessionToClaude(session, "claude-session");
    expect(lines[0]?.sessionId).toBe("claude-session");
  });

  it("syncs Claude lines back into Pi entries", () => {
    const entries = syncClaudeSessionToPi([
      {
        type: "user",
        uuid: "claude-1",
        parentUuid: null,
        sessionId: "claude-session",
        timestamp: "2026-04-05T10:00:01.000Z",
        cwd: "/repo/demo",
        message: {
          role: "user",
          content: "hello",
        },
      },
    ]);

    expect(entries[0]?.message).toMatchObject({ role: "user" });
  });

  it("creates Codex rollout items with synthetic turn boundaries", () => {
    const messages: NormalizedMessage[] = [
      {
        id: "m1",
        role: "assistant",
        timestamp: "2026-04-05T10:00:01.000Z",
        content: [{ type: "text", text: "hello" }],
      },
    ];

    const rollout = convertConversationToCodexRollout(
      messages,
      "/repo/demo",
      "thread-1",
    );
    expect(rollout.map((item) => item.type)).toEqual([
      "session_meta",
      "event_msg",
      "response_item",
      "event_msg",
    ]);
  });

  it("attaches mirrors and chooses the correct resume candidate", () => {
    const base: BridgeConversation = {
      bridgeSessionId: "bridge-1",
      projectKey: "/repo/demo",
      canonicalCwd: "/repo/demo",
      createdAt: "2026-04-05T10:00:00.000Z",
      updatedAt: "2026-04-05T10:00:00.000Z",
      status: "active",
      mirrors: {},
      lastWrittenOffsets: [],
    };
    const withClaude = attachMirror(
      base,
      "claude",
      { nativeId: "claude-1", sessionPath: "/tmp/claude-1.jsonl" },
      "2026-04-05T10:01:00.000Z",
    );

    const selected = chooseResumeCandidate(
      [
        {
          id: "older",
          path: "/tmp/older",
          sourceTool: "pi",
          updatedAt: "2026-04-05T09:00:00.000Z",
        },
        {
          id: "claude-1",
          path: "/tmp/claude-1.jsonl",
          sourceTool: "claude",
          updatedAt: "2026-04-05T08:00:00.000Z",
        },
      ],
      withClaude,
    );

    expect(selected?.id).toBe("claude-1");
  });
});
