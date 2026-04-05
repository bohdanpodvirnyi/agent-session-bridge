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

    expect(convertCodexItemToNormalized(item)).toMatchObject({
      role: "assistant",
      provider: "openai-codex",
      model: "gpt-5.4",
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("skips Codex bootstrap instruction messages", () => {
    const item: CodexRolloutItem = {
      type: "response_item",
      payload: {
        id: "codex-bootstrap-1",
        type: "message",
        role: "user",
        timestamp: "2026-04-05T10:00:00.000Z",
        content: [
          {
            type: "input_text",
            text: "<permissions instructions>\nFilesystem sandboxing defines which files can be read or written.\n</permissions instructions>",
          },
          {
            type: "input_text",
            text: "# AGENTS.md instructions for /repo/demo",
          },
        ],
      },
    };

    expect(convertCodexItemToNormalized(item)).toBeNull();
  });

  it("skips Codex turn-aborted marker messages", () => {
    const item: CodexRolloutItem = {
      type: "response_item",
      payload: {
        id: "codex-bootstrap-2",
        type: "message",
        role: "user",
        timestamp: "2026-04-05T10:00:00.000Z",
        content: [
          {
            type: "input_text",
            text: "<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>",
          },
        ],
      },
    };

    expect(convertCodexItemToNormalized(item)).toBeNull();
  });

  it("strips Codex desktop directives from assistant text", () => {
    const item: CodexRolloutItem = {
      type: "response_item",
      payload: {
        id: "codex-directives-1",
        type: "message",
        role: "assistant",
        timestamp: "2026-04-05T10:00:00.000Z",
        content: [
          {
            type: "output_text",
            text: [
              "Staging just the file removal, then I'll commit and push it on main.",
              "",
              '::git-stage{cwd=\"/repo/demo\"}',
              "",
              "Committing the deletion now.",
              "",
              '::git-commit{cwd=\"/repo/demo\"}',
              '::git-push{cwd=\"/repo/demo\" branch=\"main\"}',
              "",
              "Pushed.",
            ].join("\n"),
          },
        ],
      },
    };

    expect(convertCodexItemToNormalized(item)).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "text",
          text: [
            "Staging just the file removal, then I'll commit and push it on main.",
            "",
            "Committing the deletion now.",
            "",
            "Pushed.",
          ].join("\n"),
        },
      ],
    });
  });

  it("strips Codex image wrapper text from imported user content", () => {
    const item: CodexRolloutItem = {
      type: "response_item",
      payload: {
        id: "codex-image-1",
        type: "message",
        role: "user",
        timestamp: "2026-04-05T10:00:00.000Z",
        content: [
          { type: "input_text", text: "<image>" },
          { type: "input_image", data: "abc123", mimeType: "image/png" },
          { type: "input_text", text: "</image>" },
          { type: "input_text", text: "real prompt" },
        ],
      },
    };

    expect(convertCodexItemToNormalized(item)).toMatchObject({
      role: "user",
      content: [
        { type: "image", data: "abc123", mimeType: "image/png" },
        { type: "text", text: "real prompt" },
      ],
    });
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

  it("normalizes foreign usage objects before writing Pi entries", () => {
    const message: NormalizedMessage = {
      id: "message-usage",
      role: "assistant",
      timestamp: "2026-04-05T10:00:00.000Z",
      content: [{ type: "text", text: "hello" }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 3,
      },
    };

    expect(convertNormalizedToPiEntry(message, null).message).toMatchObject({
      role: "assistant",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 3,
        totalTokens: 20,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
    });
  });

  it("writes zeroed Pi usage for assistant messages without source usage", () => {
    const message: NormalizedMessage = {
      id: "message-no-usage",
      role: "assistant",
      timestamp: "2026-04-05T10:00:00.000Z",
      content: [{ type: "text", text: "hello" }],
    };

    expect(convertNormalizedToPiEntry(message, null).message).toMatchObject({
      role: "assistant",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
    });
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
