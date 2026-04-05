import {
  convertClaudeLineToNormalized,
  convertNormalizedToClaudeLine,
  convertNormalizedToCodexItems,
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

export function convertConversationToCodexRollout(
  messages: NormalizedMessage[],
  cwd: string,
  threadId: string,
): CodexRolloutItem[] {
  const items: CodexRolloutItem[] = [
    {
      type: "session_meta",
      payload: {
        id: threadId,
        cwd,
      },
    },
  ];

  for (const message of messages) {
    items.push({
      type: "event_msg",
      payload: {
        type: "turn_started",
        messageId: message.id,
      },
    });
    items.push(...convertNormalizedToCodexItems(message));
    items.push({
      type: "event_msg",
      payload: {
        type: "turn_complete",
        messageId: message.id,
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
