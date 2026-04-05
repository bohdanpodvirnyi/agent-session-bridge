import { describe, expect, it } from "vitest";

import {
  createConversationState,
  getConversationStatePath,
} from "../src/index.js";

describe("conversation state helpers", () => {
  it("builds per-conversation state paths", () => {
    expect(getConversationStatePath("/tmp/asb", "bridge-1")).toBe(
      "/tmp/asb/state/bridge-1.json",
    );
  });

  it("creates empty conversation state objects", () => {
    expect(createConversationState("bridge-1")).toEqual({
      bridgeSessionId: "bridge-1",
    });
  });
});
