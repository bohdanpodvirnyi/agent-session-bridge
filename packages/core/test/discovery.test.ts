import { describe, expect, it } from "vitest";

import {
  selectImportCandidate,
  type BridgeConversation,
} from "../src/index.js";

describe("import candidate selection", () => {
  it("prefers a candidate already linked in the registry", () => {
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

    const selected = selectImportCandidate(
      [
        {
          id: "older",
          path: "/tmp/older",
          sourceTool: "pi",
          updatedAt: "2026-04-05T09:00:00.000Z",
        },
        {
          id: "claude-1",
          path: "/tmp/claude-1",
          sourceTool: "claude",
          updatedAt: "2026-04-05T08:00:00.000Z",
        },
      ],
      linked,
    );

    expect(selected?.id).toBe("claude-1");
  });

  it("otherwise picks the newest candidate", () => {
    const selected = selectImportCandidate([
      {
        id: "older",
        path: "/tmp/older",
        sourceTool: "pi",
        updatedAt: "2026-04-05T09:00:00.000Z",
      },
      {
        id: "newer",
        path: "/tmp/newer",
        sourceTool: "claude",
        updatedAt: "2026-04-05T11:00:00.000Z",
      },
    ]);

    expect(selected?.id).toBe("newer");
  });
});
