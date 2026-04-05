import { describe, expect, it } from "vitest";

import { runOneShotBackfill } from "../src/index.js";

describe("daemon package", () => {
  it("runs one-shot backfill without being required for normal sync", () => {
    const result = runOneShotBackfill([
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
});
