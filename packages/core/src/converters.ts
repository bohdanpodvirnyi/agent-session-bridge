import type {
  ClaudeCodeLine,
  CodexRolloutItem,
  NormalizedContent,
  NormalizedMessage,
  PiSessionEntry,
} from "./types.js";

function normalizeContentItem(item: unknown): NormalizedContent[] {
  if (typeof item === "string") {
    return [{ type: "text", text: item }];
  }

  if (typeof item !== "object" || item === null) {
    return [{ type: "text", text: JSON.stringify(item) }];
  }

  const candidate = item as Record<string, unknown>;

  if (candidate.type === "text" && typeof candidate.text === "string") {
    return [{ type: "text", text: candidate.text }];
  }

  if (candidate.type === "thinking" && typeof candidate.thinking === "string") {
    return [{ type: "thinking", thinking: candidate.thinking }];
  }

  if (
    candidate.type === "toolCall" &&
    typeof candidate.id === "string" &&
    typeof candidate.name === "string"
  ) {
    return [
      {
        type: "tool_call",
        id: candidate.id,
        name: candidate.name,
        arguments: (candidate.arguments as Record<string, unknown>) ?? {},
      },
    ];
  }

  if (
    candidate.type === "tool_use" &&
    typeof candidate.id === "string" &&
    typeof candidate.name === "string"
  ) {
    return [
      {
        type: "tool_call",
        id: candidate.id,
        name: candidate.name,
        arguments: (candidate.input as Record<string, unknown>) ?? {},
      },
    ];
  }

  if (
    candidate.type === "tool_result" &&
    typeof candidate.tool_use_id === "string"
  ) {
    return [
      {
        type: "tool_result",
        toolCallId: candidate.tool_use_id,
        output:
          typeof candidate.content === "string"
            ? candidate.content
            : JSON.stringify(candidate.content),
        isError: Boolean(candidate.is_error),
      },
    ];
  }

  if (candidate.type === "image") {
    return [
      {
        type: "image",
        data: String(candidate.data ?? candidate.url ?? ""),
        mimeType:
          typeof candidate.mimeType === "string"
            ? candidate.mimeType
            : undefined,
      },
    ];
  }

  return [{ type: "text", text: JSON.stringify(candidate) }];
}

function normalizeContentList(content: unknown): NormalizedContent[] {
  if (Array.isArray(content)) {
    return content.flatMap((item) => normalizeContentItem(item));
  }

  return normalizeContentItem(content);
}

export function convertPiEntryToNormalized(
  entry: PiSessionEntry,
): NormalizedMessage | null {
  const message = entry.message as Record<string, unknown> | undefined;
  if (!message || typeof message.role !== "string") {
    return null;
  }

  const role = message.role;

  if (!role) {
    return null;
  }

  if (role === "toolResult") {
    return {
      id: entry.id ?? "pi-tool-result",
      role: "tool",
      timestamp: entry.timestamp ?? new Date(0).toISOString(),
      content: [
        {
          type: "tool_result",
          toolCallId: String(message.toolCallId ?? ""),
          toolName:
            typeof message.toolName === "string" ? message.toolName : undefined,
          output: JSON.stringify(message.content ?? []),
          isError: Boolean(message.isError),
        },
      ],
    };
  }

  return {
    id: entry.id ?? "pi-message",
    role: role === "assistant" ? "assistant" : "user",
    timestamp: entry.timestamp ?? new Date(0).toISOString(),
    content: normalizeContentList(message.content),
    model: typeof message.model === "string" ? message.model : undefined,
    provider:
      typeof message.provider === "string" ? message.provider : undefined,
    stopReason:
      typeof message.stopReason === "string" ? message.stopReason : undefined,
    usage:
      typeof message.usage === "object" && message.usage
        ? (message.usage as Record<string, number>)
        : undefined,
  };
}

export function convertClaudeLineToNormalized(
  line: ClaudeCodeLine,
): NormalizedMessage | null {
  if (!line.message || typeof line.message !== "object") {
    return null;
  }

  const role =
    typeof line.message.role === "string"
      ? line.message.role
      : line.type === "assistant"
        ? "assistant"
        : "user";
  return {
    id: line.uuid ?? "claude-message",
    role: role === "assistant" ? "assistant" : "user",
    timestamp: line.timestamp ?? new Date(0).toISOString(),
    content: normalizeContentList(line.message.content),
    model:
      typeof line.message.model === "string" ? line.message.model : undefined,
    stopReason:
      typeof line.message.stop_reason === "string"
        ? line.message.stop_reason
        : undefined,
    usage:
      typeof line.message.usage === "object" && line.message.usage
        ? (line.message.usage as Record<string, number>)
        : undefined,
  };
}

export function convertCodexItemToNormalized(
  item: CodexRolloutItem,
): NormalizedMessage | null {
  if (item.type === "response_item" && item.payload.type === "message") {
    return {
      id: String(item.payload.id ?? "codex-message"),
      role: item.payload.role === "assistant" ? "assistant" : "user",
      timestamp: String(item.payload.timestamp ?? new Date(0).toISOString()),
      content: normalizeContentList(item.payload.content),
    };
  }

  if (
    item.type === "response_item" &&
    item.payload.type === "function_call_output"
  ) {
    return {
      id: String(item.payload.call_id ?? "codex-tool"),
      role: "tool",
      timestamp: String(item.payload.timestamp ?? new Date(0).toISOString()),
      content: [
        {
          type: "tool_result",
          toolCallId: String(item.payload.call_id ?? ""),
          output:
            typeof item.payload.output === "string"
              ? item.payload.output
              : JSON.stringify(item.payload.output),
        },
      ],
    };
  }

  return null;
}

export function convertNormalizedToPiEntry(
  message: NormalizedMessage,
  parentId: string | null,
): PiSessionEntry {
  if (message.role === "tool") {
    const result = message.content.find((item) => item.type === "tool_result");
    return {
      type: "message",
      id: message.id,
      parentId,
      timestamp: message.timestamp,
      message: {
        role: "toolResult",
        toolCallId: result?.type === "tool_result" ? result.toolCallId : "",
        toolName: result?.type === "tool_result" ? result.toolName : undefined,
        content:
          result?.type === "tool_result"
            ? [{ type: "text", text: result.output }]
            : [],
        isError:
          result?.type === "tool_result" ? Boolean(result.isError) : false,
      },
    };
  }

  return {
    type: "message",
    id: message.id,
    parentId,
    timestamp: message.timestamp,
    message: {
      role: message.role,
      content: message.content.map((item) => {
        if (item.type === "text") {
          return { type: "text", text: item.text };
        }
        if (item.type === "thinking") {
          return { type: "thinking", thinking: item.thinking };
        }
        if (item.type === "tool_call") {
          return {
            type: "toolCall",
            id: item.id,
            name: item.name,
            arguments: item.arguments,
          };
        }
        if (item.type === "image") {
          return { type: "image", data: item.data, mimeType: item.mimeType };
        }
        return { type: "text", text: item.output };
      }),
      model: message.model,
      provider: message.provider,
      stopReason: message.stopReason,
      usage: message.usage,
    },
  };
}

export function convertNormalizedToClaudeLine(
  message: NormalizedMessage,
  sessionId: string,
  parentUuid: string | null,
  cwd: string,
): ClaudeCodeLine {
  return {
    type: message.role === "assistant" ? "assistant" : "user",
    uuid: message.id,
    parentUuid,
    sessionId,
    cwd,
    timestamp: message.timestamp,
    message: {
      role: message.role === "tool" ? "user" : message.role,
      content: message.content.map((item) => {
        if (item.type === "text") {
          return { type: "text", text: item.text };
        }
        if (item.type === "thinking") {
          return { type: "thinking", thinking: item.thinking, signature: "" };
        }
        if (item.type === "tool_call") {
          return {
            type: "tool_use",
            id: item.id,
            name: item.name,
            input: item.arguments,
          };
        }
        if (item.type === "tool_result") {
          return {
            type: "tool_result",
            tool_use_id: item.toolCallId,
            content: item.output,
            is_error: Boolean(item.isError),
          };
        }
        return { type: "image", data: item.data, mimeType: item.mimeType };
      }),
      model: message.model,
      stop_reason: message.stopReason,
      usage: message.usage,
    },
  };
}

export function convertNormalizedToCodexItems(
  message: NormalizedMessage,
): CodexRolloutItem[] {
  return [
    {
      type: "response_item",
      payload: {
        id: message.id,
        type: "message",
        role: message.role === "tool" ? "assistant" : message.role,
        timestamp: message.timestamp,
        content: message.content.map((item) => {
          if (item.type === "text") {
            return {
              type: message.role === "assistant" ? "output_text" : "input_text",
              text: item.text,
            };
          }
          if (item.type === "tool_call") {
            return {
              type: "function_call",
              call_id: item.id,
              name: item.name,
              arguments: item.arguments,
            };
          }
          if (item.type === "tool_result") {
            return {
              type: "function_call_output",
              call_id: item.toolCallId,
              output: item.output,
            };
          }
          if (item.type === "thinking") {
            return { type: "reasoning", text: item.thinking };
          }
          return {
            type: "input_image",
            data: item.data,
            mimeType: item.mimeType,
          };
        }),
      },
    },
  ];
}
