import { describe, expect, it } from "vitest";

import {
  buildExperimentalRollout,
  discoverRolloutPath,
  parseCodexHookPayload,
  registerCodexMirror,
} from "../src/index.js";

describe("codex hooks", () => {
  it("discovers a rollout path from session context", () => {
    const path = discoverRolloutPath(
      "thread-1",
      "/repo/demo",
      new Date("2026-04-05T10:00:00.000Z"),
    );
    expect(path).toContain(
      "/repo/demo/.codex/sessions/2026/04/05/rollout-thread-1.jsonl",
    );
  });

  it("builds an experimental rollout with synthetic boundaries", () => {
    const rollout = buildExperimentalRollout(
      [
        {
          id: "message-1",
          role: "assistant",
          timestamp: "2026-04-05T10:00:00.000Z",
          content: [{ type: "text", text: "hello" }],
        },
      ],
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

  it("parses hook payloads and registers a Codex mirror", () => {
    expect(
      parseCodexHookPayload(
        JSON.stringify({ session_id: "thread-1", cwd: "/repo/demo" }),
      ),
    ).toEqual({
      session_id: "thread-1",
      cwd: "/repo/demo",
    });

    const conversation = registerCodexMirror(
      {
        bridgeSessionId: "bridge-1",
        projectKey: "/repo/demo",
        canonicalCwd: "/repo/demo",
        createdAt: "2026-04-05T10:00:00.000Z",
        updatedAt: "2026-04-05T10:00:00.000Z",
        status: "active",
        mirrors: {},
        lastWrittenOffsets: [],
      },
      "thread-1",
      "/repo/demo/.codex/sessions/2026/04/05/rollout-thread-1.jsonl",
      "2026-04-05T10:01:00.000Z",
    );

    expect(conversation.mirrors.codex?.nativeId).toBe("thread-1");
  });
});
