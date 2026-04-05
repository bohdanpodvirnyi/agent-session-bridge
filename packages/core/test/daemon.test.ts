import { describe, expect, it } from "vitest";

import {
  oneShotBackfill,
  startWatchMode,
  type BridgeConversation,
} from "../src/index.js";

describe("daemon helpers", () => {
  it("selects one candidate during one-shot backfill", () => {
    const result = oneShotBackfill([
      {
        id: "old",
        path: "/tmp/old",
        sourceTool: "pi",
        updatedAt: "2026-04-05T10:00:00.000Z",
      },
      {
        id: "new",
        path: "/tmp/new",
        sourceTool: "claude",
        updatedAt: "2026-04-05T11:00:00.000Z",
      },
    ]);

    expect(result.selected?.id).toBe("new");
    expect(result.reusedRegistryLogic).toBe(true);
  });

  it("reuses linked-conversation selection when available", () => {
    const linked: BridgeConversation = {
      bridgeSessionId: "bridge-1",
      projectKey: "/repo/demo",
      canonicalCwd: "/repo/demo",
      createdAt: "2026-04-05T10:00:00.000Z",
      updatedAt: "2026-04-05T10:00:00.000Z",
      status: "active",
      mirrors: {
        claude: {
          nativeId: "claude-1",
          sessionPath: "/tmp/claude-1",
        },
      },
      lastWrittenOffsets: [],
    };

    const result = oneShotBackfill(
      [
        {
          id: "claude-1",
          path: "/tmp/claude-1",
          sourceTool: "claude",
          updatedAt: "2026-04-05T08:00:00.000Z",
        },
      ],
      linked,
    );

    expect(result.selected?.id).toBe("claude-1");
  });

  it("supports optional watch mode for repair and catch-up", () => {
    let ticks = 0;
    const watcher = startWatchMode(() => {
      ticks += 1;
    });

    watcher.stop();
    expect(ticks).toBe(1);
  });
});
