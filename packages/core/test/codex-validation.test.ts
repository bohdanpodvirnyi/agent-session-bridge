import { describe, expect, it } from "vitest";

import {
  buildExperimentalRollout,
  discoverRolloutPath,
} from "../../codex/src/index.js";

describe("codex validation gate", () => {
  it("creates a rollout path that matches the expected resume location pattern", () => {
    const path = discoverRolloutPath(
      "thread-1",
      "/repo/demo",
      new Date("2026-04-05T10:00:00.000Z"),
    );
    expect(path).toContain("rollout-thread-1.jsonl");
  });

  it("builds a rollout with resumable boundaries around each message", () => {
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

    expect(rollout[0]?.type).toBe("session_meta");
    expect(rollout[1]?.type).toBe("event_msg");
    expect(rollout[3]?.type).toBe("event_msg");
  });
});
