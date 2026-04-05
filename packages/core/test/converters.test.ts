import { describe, expect, it } from "vitest";

import {
  convertClaudeLineToNormalized,
  convertCodexItemToNormalized,
  convertNormalizedToClaudeLine,
  convertNormalizedToCodexItems,
  convertNormalizedToPiEntry,
  convertPiEntryToNormalized,
  type ClaudeCodeLine,
  type CodexRolloutItem,
  type NormalizedMessage,
  type PiSessionEntry,
} from "../src/index.js";

describe("converters", () => {
  it("converts Pi entries to the normalized model", () => {
    const entry: PiSessionEntry = {
      type: "message",
      id: "pi-1",
      parentId: null,
      timestamp: "2026-04-05T10:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "hello" },
          {
            type: "toolCall",
            id: "call_1",
            name: "read",
            arguments: { path: "a" },
          },
        ],
      },
    };

    expect(convertPiEntryToNormalized(entry)).toMatchObject({
      id: "pi-1",
      role: "assistant",
    });
  });

  it("converts Claude lines to the normalized model", () => {
    const line: ClaudeCodeLine = {
      type: "assistant",
      uuid: "claude-1",
      timestamp: "2026-04-05T10:00:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      },
    };

    expect(convertClaudeLineToNormalized(line)?.content[0]).toEqual({
      type: "text",
      text: "hello",
    });
  });

  it("converts Codex items to the normalized model", () => {
    const item: CodexRolloutItem = {
      type: "response_item",
      payload: {
        id: "codex-1",
        type: "message",
        role: "assistant",
        timestamp: "2026-04-05T10:00:00.000Z",
        content: [{ type: "output_text", text: "hello" }],
      },
    };

    expect(convertCodexItemToNormalized(item)?.role).toBe("assistant");
  });

  it("converts normalized messages back to Pi, Claude, and Codex shapes", () => {
    const message: NormalizedMessage = {
      id: "message-1",
      role: "assistant",
      timestamp: "2026-04-05T10:00:00.000Z",
      content: [{ type: "text", text: "hello" }],
    };

    expect(convertNormalizedToPiEntry(message, null).message).toMatchObject({
      role: "assistant",
    });
    expect(
      convertNormalizedToClaudeLine(message, "session-1", null, "/repo/demo")
        .message,
    ).toMatchObject({
      role: "assistant",
    });
    expect(convertNormalizedToCodexItems(message)[0]?.type).toBe(
      "response_item",
    );
  });

  it("degrades unsupported content to text safely", () => {
    const line: ClaudeCodeLine = {
      type: "user",
      uuid: "claude-unsupported",
      timestamp: "2026-04-05T10:00:00.000Z",
      message: {
        role: "user",
        content: [{ type: "custom-block", strange: true }],
      },
    };

    expect(convertClaudeLineToNormalized(line)?.content[0]).toMatchObject({
      type: "text",
    });
  });
});
