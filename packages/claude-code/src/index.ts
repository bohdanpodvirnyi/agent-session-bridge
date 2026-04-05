import {
  chooseResumeCandidate,
  markConversationConflicted,
  type BridgeConversation,
  type ClaudeCodeLine,
  type SessionCandidate,
} from "agent-session-bridge-core";

export function handleSessionStart(
  candidates: SessionCandidate[],
  linkedConversation?: BridgeConversation,
): SessionCandidate | null {
  return chooseResumeCandidate(candidates, linkedConversation);
}

export interface ClaudeHookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
}

export function parseClaudeHookPayload(raw: string): ClaudeHookPayload {
  return JSON.parse(raw) as ClaudeHookPayload;
}

export function handleStop(
  transcript: ClaudeCodeLine[],
  conversation: BridgeConversation,
): { linesProcessed: number; conversation: BridgeConversation } {
  if (transcript.length === 0) {
    return {
      linesProcessed: 0,
      conversation,
    };
  }

  const uniqueIds = new Set(
    transcript.map((line) => line.uuid).filter(Boolean),
  );
  if (uniqueIds.size !== transcript.length) {
    return {
      linesProcessed: transcript.length,
      conversation: markConversationConflicted(
        conversation,
        "duplicate Claude transcript UUIDs detected",
        new Date().toISOString(),
      ),
    };
  }

  return {
    linesProcessed: transcript.length,
    conversation,
  };
}
