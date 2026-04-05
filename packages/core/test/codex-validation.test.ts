import { describe, expect, it } from "vitest";

import {
  generateCodexThreadId,
  isCodexThreadId,
} from "../src/index.js";
import {
  buildExperimentalRollout,
  discoverRolloutPath,
} from "../../codex/src/index.js";

describe("codex validation gate", () => {
  it("creates a rollout path that matches the expected resume location pattern", () => {
    const date = new Date(2026, 3, 5, 10, 0, 0);
    const threadId = generateCodexThreadId(date);
    const path = discoverRolloutPath(
      threadId,
      date,
      "/repo/demo/.codex",
    );
    expect(path).toContain(threadId);
    expect(path).toContain("rollout-2026-04-05T10-00-00-");
  });

  it("builds a rollout with resumable task envelopes and a Codex-compatible thread id", () => {
    const threadId = generateCodexThreadId(new Date(2026, 3, 5, 10, 0, 0));
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
      threadId,
    );

    expect(rollout[0]?.type).toBe("session_meta");
    expect(isCodexThreadId(rollout[0]!.payload.id)).toBe(true);
    expect(rollout[1]?.payload.type).toBe("task_started");
    expect(rollout[2]?.type).toBe("turn_context");
    expect(rollout.at(-1)?.payload.type).toBe("task_complete");
  });
});
