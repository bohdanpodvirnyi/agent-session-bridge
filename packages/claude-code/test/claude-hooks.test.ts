import { describe, expect, it } from "vitest";

import {
  handleSessionStart,
  handleStop,
  parseClaudeHookPayload,
} from "../src/index.js";

describe("claude hooks", () => {
  it("chooses the latest session on first open", () => {
    const selected = handleSessionStart([
      {
        id: "old",
        path: "/tmp/old",
        sourceTool: "pi",
        updatedAt: "2026-04-05T10:00:00.000Z",
      },
      {
        id: "new",
        path: "/tmp/new",
        sourceTool: "pi",
        updatedAt: "2026-04-05T11:00:00.000Z",
      },
    ]);

    expect(selected?.id).toBe("new");
  });

  it("flags conflicting transcripts without blocking processing", () => {
    const result = handleStop(
      [
        {
          type: "assistant",
          uuid: "dup",
          message: { role: "assistant", content: "hi" },
        },
        {
          type: "assistant",
          uuid: "dup",
          message: { role: "assistant", content: "hi again" },
        },
      ],
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
    );

    expect(result.linesProcessed).toBe(2);
    expect(result.conversation.status).toBe("conflicted");
  });

  it("parses hook payload JSON from stdin", () => {
    expect(
      parseClaudeHookPayload(
        JSON.stringify({
          session_id: "claude-1",
          transcript_path: "/tmp/transcript.jsonl",
          cwd: "/repo/demo",
        }),
      ),
    ).toEqual({
      session_id: "claude-1",
      transcript_path: "/tmp/transcript.jsonl",
      cwd: "/repo/demo",
    });
  });
});
