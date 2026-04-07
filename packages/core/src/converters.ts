import { createHash } from "node:crypto";

import type {
  ClaudeCodeLine,
  CodexRolloutItem,
  NormalizedContent,
  NormalizedMessage,
  PiSessionEntry,
} from "./types.js";

function codexFallbackId(item: CodexRolloutItem): string {
  const digest = createHash("sha1")
    .update(JSON.stringify(item.payload))
    .digest("hex");
  return digest.slice(0, 12);
}

function codexItemTimestamp(item: CodexRolloutItem): string {
  return (
    ((item as { timestamp?: unknown }).timestamp as string | undefined) ??
    (typeof item.payload.timestamp === "string"
      ? item.payload.timestamp
      : undefined) ??
    new Date(0).toISOString()
  );
}

const codexBootstrapPrefixes = [
  "<permissions instructions>",
  "<app-context>",
  "<collaboration_mode>",
  "<apps_instructions>",
  "<skills_instructions>",
  "<plugins_instructions>",
  "# AGENTS.md instructions for ",
  "<environment_context>",
  "<turn_aborted>",
  "When you write or edit a git commit message, ensure the message ends with this trailer exactly once:",
];

const codexDirectiveLinePattern =
  /^::(?:git-[a-z-]+|automation-update|code-comment|archive)\{[^]*\}$/;

function unwrapStructuredText(text: string): string {
  let current = text;

  for (let depth = 0; depth < 4; depth += 1) {
    try {
      const parsed = JSON.parse(current) as Record<string, unknown>;
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed.type === "input_text" || parsed.type === "output_text") &&
        typeof parsed.text === "string"
      ) {
        current = parsed.text;
        continue;
      }
    } catch {
      return current;
    }

    return current;
  }

  return current;
}

function isCodexBootstrapText(text: string): boolean {
  const normalized = unwrapStructuredText(text).trimStart();
  return codexBootstrapPrefixes.some((prefix) => normalized.startsWith(prefix));
}

function isCodexBootstrapMessage(message: NormalizedMessage): boolean {
  if (message.role !== "user" || message.content.length === 0) {
    return false;
  }

  return message.content.every(
    (item) =>
      item.type === "text" &&
      typeof item.text === "string" &&
      isCodexBootstrapText(item.text),
  );
}

function stripCodexDirectiveLines(text: string): string {
  const lines = text.split("\n");
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return true;
    }

    return !codexDirectiveLinePattern.test(trimmed);
  });

  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripImageWrapperText(
  content: NormalizedContent[],
): NormalizedContent[] {
  return content.filter((item) => {
    if (item.type !== "text" || typeof item.text !== "string") {
      return true;
    }

    const text = item.text.trim();
    return text !== "<image>" && text !== "</image>";
  });
}

function serializeUnknownText(value: unknown): string | null {
  const serialized = JSON.stringify(value);
  return typeof serialized === "string" ? serialized : null;
}

function sanitizeClaudeToolIdentifier(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]+/g, "_");
  return sanitized || "tool_use";
}

function normalizeContentItem(item: unknown): NormalizedContent[] {
  if (typeof item === "string") {
    return [{ type: "text", text: item }];
  }

  if (typeof item === "undefined") {
    return [];
  }

  if (typeof item !== "object" || item === null) {
    const serialized = serializeUnknownText(item);
    return serialized ? [{ type: "text", text: serialized }] : [];
  }

  const candidate = item as Record<string, unknown>;

  if (candidate.type === "text" && typeof candidate.text === "string") {
    const sanitized = stripCodexDirectiveLines(candidate.text);
    return sanitized ? [{ type: "text", text: sanitized }] : [];
  }

  if (
    (candidate.type === "input_text" || candidate.type === "output_text") &&
    typeof candidate.text === "string"
  ) {
    const sanitized = stripCodexDirectiveLines(candidate.text);
    return sanitized ? [{ type: "text", text: sanitized }] : [];
  }

  if (candidate.type === "thinking" && typeof candidate.thinking === "string") {
    return [{ type: "thinking", thinking: candidate.thinking }];
  }

  if (candidate.type === "reasoning" && typeof candidate.text === "string") {
    return [{ type: "thinking", thinking: candidate.text }];
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
    candidate.type === "function_call" &&
    typeof candidate.call_id === "string" &&
    typeof candidate.name === "string"
  ) {
    return [
      {
        type: "tool_call",
        id: candidate.call_id,
        name: candidate.name,
        arguments: (candidate.arguments as Record<string, unknown>) ?? {},
      },
    ];
  }

  if (
    candidate.type === "tool_result" &&
    typeof candidate.tool_use_id === "string"
  ) {
    const output = typeof candidate.content === "string"
      ? candidate.content
      : serializeUnknownText(candidate.content);
    if (output === null) {
      return [];
    }
    return [
      {
        type: "tool_result",
        toolCallId: candidate.tool_use_id,
        output,
        isError: Boolean(candidate.is_error),
      },
    ];
  }

  if (
    candidate.type === "function_call_output" &&
    typeof candidate.call_id === "string"
  ) {
    const output = typeof candidate.output === "string"
      ? candidate.output
      : serializeUnknownText(candidate.output);
    if (output === null) {
      return [];
    }
    return [
      {
        type: "tool_result",
        toolCallId: candidate.call_id,
        output,
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

  if (candidate.type === "input_image") {
    return [
      {
        type: "image",
        data: String(candidate.data ?? ""),
        mimeType:
          typeof candidate.mimeType === "string"
            ? candidate.mimeType
            : undefined,
      },
    ];
  }

  const serialized = serializeUnknownText(candidate);
  return serialized ? [{ type: "text", text: serialized }] : [];
}

function normalizeContentList(content: unknown): NormalizedContent[] {
  const normalized = Array.isArray(content)
    ? content.flatMap((item) => normalizeContentItem(item))
    : normalizeContentItem(content);

  return stripImageWrapperText(normalized);
}

function readUsageNumber(
  usage: Record<string, unknown>,
  ...keys: string[]
): number {
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return 0;
}

function normalizePiUsage(
  usage: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const source = usage ?? {};

  const input = readUsageNumber(source, "input", "input_tokens");
  const output = readUsageNumber(source, "output", "output_tokens");
  const cacheRead = readUsageNumber(
    source,
    "cacheRead",
    "cache_read_input_tokens",
  );
  const cacheWrite = readUsageNumber(
    source,
    "cacheWrite",
    "cache_creation_input_tokens",
  );
  const totalTokens =
    readUsageNumber(source, "totalTokens", "total_tokens") ||
    input + output + cacheRead + cacheWrite;

  const costCandidate =
    typeof source.cost === "object" && source.cost !== null
      ? (source.cost as Record<string, unknown>)
      : {};
  const cost = {
    input: readUsageNumber(costCandidate, "input"),
    output: readUsageNumber(costCandidate, "output"),
    cacheRead: readUsageNumber(costCandidate, "cacheRead"),
    cacheWrite: readUsageNumber(costCandidate, "cacheWrite"),
    total: readUsageNumber(costCandidate, "total"),
  };

  return {
    ...source,
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost,
  };
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
        ? (message.usage as Record<string, unknown>)
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
    ...(role === "assistant"
      ? {
          provider: "anthropic",
          model:
            typeof line.message.model === "string"
              ? line.message.model
              : "claude-sonnet-4-20250514",
        }
      : {
          model:
            typeof line.message.model === "string"
              ? line.message.model
              : undefined,
        }),
    stopReason:
      typeof line.message.stop_reason === "string"
        ? line.message.stop_reason
        : undefined,
    usage:
      typeof line.message.usage === "object" && line.message.usage
        ? (line.message.usage as Record<string, unknown>)
        : undefined,
  };
}

export function convertCodexItemToNormalized(
  item: CodexRolloutItem,
): NormalizedMessage | null {
  if (item.type === "response_item" && item.payload.type === "message") {
    const role = item.payload.role === "assistant" ? "assistant" : "user";
    const normalized: NormalizedMessage = {
      id:
        typeof item.payload.id === "string"
          ? item.payload.id
          : `codex-${codexFallbackId(item)}`,
      role,
      timestamp: codexItemTimestamp(item),
      content: normalizeContentList(item.payload.content),
      ...(role === "assistant"
        ? {
            provider: "openai-codex",
            model: "gpt-5.4",
          }
        : {}),
    };

    if (isCodexBootstrapMessage(normalized)) {
      return null;
    }

    return normalized;
  }

  if (
    item.type === "response_item" &&
    item.payload.type === "function_call_output"
  ) {
    return {
      id:
        typeof item.payload.call_id === "string"
          ? item.payload.call_id
          : `codex-tool-${codexFallbackId(item)}`,
      role: "tool",
      timestamp: codexItemTimestamp(item),
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
      usage:
        message.role === "assistant"
          ? normalizePiUsage(message.usage)
          : message.usage,
    },
  };
}

export function convertNormalizedToClaudeLine(
  message: NormalizedMessage,
  sessionId: string,
  parentUuid: string | null,
  cwd: string,
): ClaudeCodeLine {
  const content: Record<string, unknown>[] = [];

  for (const item of message.content) {
    if (item.type === "text") {
      content.push({ type: "text", text: item.text });
      continue;
    }
    if (item.type === "thinking") {
      continue;
    }
    if (item.type === "tool_call") {
      content.push({
        type: "tool_use",
        id: sanitizeClaudeToolIdentifier(item.id),
        name: item.name,
        input: item.arguments,
      });
      continue;
    }
    if (item.type === "tool_result") {
      content.push({
        type: "tool_result",
        tool_use_id: sanitizeClaudeToolIdentifier(item.toolCallId),
        content: item.output,
        is_error: Boolean(item.isError),
      });
      continue;
    }
    content.push({ type: "image", data: item.data, mimeType: item.mimeType });
  }

  return {
    type: message.role === "assistant" ? "assistant" : "user",
    uuid: message.id,
    parentUuid,
    sessionId,
    cwd,
    timestamp: message.timestamp,
    message: {
      role: message.role === "tool" ? "user" : message.role,
      content,
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
