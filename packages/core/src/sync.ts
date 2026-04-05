import { createHash } from "node:crypto";

import {
  convertClaudeLineToNormalized,
  convertNormalizedToClaudeLine,
  convertNormalizedToPiEntry,
  convertPiEntryToNormalized,
} from "./converters.js";
import { selectImportCandidate, type SessionCandidate } from "./discovery.js";
import { flattenPiActiveBranch } from "./parsers.js";
import type {
  BridgeConversation,
  ClaudeCodeLine,
  CodexRolloutItem,
  NormalizedMessage,
  PiSession,
  PiSessionEntry,
  ToolMirror,
  ToolName,
} from "./types.js";

export function syncPiSessionToClaude(
  session: PiSession,
  sessionId: string,
): ClaudeCodeLine[] {
  const entries = flattenPiActiveBranch(session);
  let parentUuid: string | null = null;

  return entries.flatMap((entry) => {
    const normalized = convertPiEntryToNormalized(entry);
    if (!normalized) {
      return [];
    }

    const line = convertNormalizedToClaudeLine(
      normalized,
      sessionId,
      parentUuid,
      session.header.cwd,
    );
    parentUuid = line.uuid ?? parentUuid;
    return [line];
  });
}

export function syncClaudeSessionToPi(
  lines: ClaudeCodeLine[],
): PiSessionEntry[] {
  let parentId: string | null = null;

  return lines.flatMap((line) => {
    const normalized = convertClaudeLineToNormalized(line);
    if (!normalized) {
      return [];
    }
    const entry = convertNormalizedToPiEntry(normalized, parentId);
    parentId = entry.id ?? parentId;
    return [entry];
  });
}

export interface CodexRolloutTemplate {
  sessionMeta: Record<string, unknown>;
  taskStarted: Record<string, unknown>;
  turnContext: Record<string, unknown>;
}

export interface ConvertConversationToCodexOptions {
  includeSessionMeta?: boolean;
  template?: CodexRolloutTemplate;
}

function deterministicHex(seed: string): string {
  return createHash("sha1").update(seed).digest("hex");
}

function formatUuidParts(hex: string): string {
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function codexLikeTurnId(seed: string, timestamp: string): string {
  const base = deterministicHex(`${timestamp}:${seed}`).slice(0, 32).split("");
  base[12] = "7";
  const variantNibble = Number.parseInt(base[16] ?? "8", 16);
  base[16] = ((variantNibble & 0x3) | 0x8).toString(16);
  return formatUuidParts(base.join(""));
}

function extractMessageText(message: NormalizedMessage): string | null {
  const text = message.content
    .flatMap((item) => {
      if (item.type === "text") {
        return [item.text];
      }
      if (item.type === "thinking") {
        return [item.thinking];
      }
      return [];
    })
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");

  return text.length > 0 ? text : null;
}

function convertMessageToCodexPayloads(
  message: NormalizedMessage,
): Record<string, unknown>[] {
  if (message.role === "tool") {
    return message.content.flatMap((item) => {
      if (item.type !== "tool_result") {
        return [];
      }

      return [
        {
          type: "function_call_output",
          call_id: item.toolCallId,
          output: item.output,
        },
      ];
    });
  }

  return [
    {
      type: "message",
      role: message.role,
      content: message.content.map((item) => {
        if (item.type === "text") {
          return {
            type: message.role === "assistant" ? "output_text" : "input_text",
            text: item.text,
          };
        }
        if (item.type === "thinking") {
          return {
            type: message.role === "assistant" ? "output_text" : "input_text",
            text: item.thinking,
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
        return {
          type: "input_image",
          data: item.data,
          mimeType: item.mimeType,
        };
      }),
      ...(message.role === "assistant" ? { phase: "final_answer" } : {}),
    },
  ];
}

function groupMessagesForCodexTasks(
  messages: NormalizedMessage[],
): NormalizedMessage[][] {
  const groups: NormalizedMessage[][] = [];
  let current: NormalizedMessage[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      if (current.length > 0) {
        groups.push(current);
      }
      current = [message];
      continue;
    }

    if (current.length === 0) {
      current = [message];
      continue;
    }

    current.push(message);
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}

function buildFallbackCodexTemplate(
  cwd: string,
  timestamp: string,
): CodexRolloutTemplate {
  return {
    sessionMeta: {
      timestamp,
      cwd,
      originator: "Agent Session Bridge",
      cli_version: "0.115.0",
      source: "exec",
      model_provider: "openai",
      base_instructions: {
        text: "Imported by Agent Session Bridge.",
      },
    },
    taskStarted: {
      type: "task_started",
      model_context_window: 258400,
      collaboration_mode_kind: "default",
    },
    turnContext: {
      cwd,
      current_date: timestamp.slice(0, 10),
      timezone: "UTC",
      approval_policy: "never",
      sandbox_policy: {
        type: "workspace-write",
        writable_roots: [],
        network_access: false,
        exclude_tmpdir_env_var: false,
        exclude_slash_tmp: false,
      },
      model: "gpt-5.4",
      personality: "friendly",
      collaboration_mode: {
        mode: "default",
        settings: {
          model: "gpt-5.4",
          reasoning_effort: "medium",
          developer_instructions: null,
        },
      },
      realtime_active: false,
      effort: "medium",
      summary: "none",
      user_instructions: "",
    },
  };
}

export function convertConversationToCodexRollout(
  messages: NormalizedMessage[],
  cwd: string,
  threadId: string,
  options: ConvertConversationToCodexOptions = {},
): CodexRolloutItem[] {
  if (messages.length === 0) {
    return [];
  }

  const firstTimestamp = messages[0]!.timestamp;
  const template =
    options.template ?? buildFallbackCodexTemplate(cwd, firstTimestamp);
  const items: CodexRolloutItem[] = [];

  if (options.includeSessionMeta !== false) {
    items.push({
      type: "session_meta",
      payload: {
        id: threadId,
        ...template.sessionMeta,
        cwd,
        timestamp: firstTimestamp,
      },
    });
  }

  const groups = groupMessagesForCodexTasks(messages);

  for (const [index, group] of groups.entries()) {
    const taskSeed = group.map((message) => message.id).join(":") || `${index}`;
    const taskTimestamp = group[0]!.timestamp;
    const turnId = codexLikeTurnId(
      `${threadId}:${index}:${taskSeed}`,
      taskTimestamp,
    );
    const lastAssistantText =
      [...group]
        .reverse()
        .flatMap((message) =>
          message.role === "assistant"
            ? [extractMessageText(message)]
            : [],
        )
        .find((value): value is string => Boolean(value)) ?? "";

    items.push({
      type: "event_msg",
      payload: {
        ...template.taskStarted,
        type: "task_started",
        turn_id: turnId,
      },
    });

    items.push({
      type: "turn_context",
      payload: {
        ...template.turnContext,
        turn_id: turnId,
        cwd,
        current_date: taskTimestamp.slice(0, 10),
      },
    });

    for (const message of group) {
      for (const payload of convertMessageToCodexPayloads(message)) {
        items.push({
          type: "response_item",
          payload,
        });
      }

      if (message.role === "user") {
        const userText = extractMessageText(message) ?? "";
        items.push({
          type: "event_msg",
          payload: {
            type: "user_message",
            message: userText,
            images: [],
            local_images: [],
            text_elements: [],
          },
        });
      }

      if (message.role === "assistant") {
        const assistantText = extractMessageText(message);
        if (assistantText) {
          items.push({
            type: "event_msg",
            payload: {
              type: "agent_message",
              message: assistantText,
              phase: "final_answer",
            },
          });
        }
      }
    }

    items.push({
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: turnId,
        last_agent_message: lastAssistantText,
      },
    });
  }

  return items;
}

export function attachMirror(
  conversation: BridgeConversation,
  tool: ToolName,
  mirror: ToolMirror,
  updatedAt: string,
): BridgeConversation {
  return {
    ...conversation,
    updatedAt,
    mirrors: {
      ...conversation.mirrors,
      [tool]: mirror,
    },
  };
}

export function chooseResumeCandidate(
  candidates: SessionCandidate[],
  linkedConversation?: BridgeConversation,
): SessionCandidate | null {
  return selectImportCandidate(candidates, linkedConversation);
}
