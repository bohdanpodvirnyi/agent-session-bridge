import {
  attachMirror,
  convertConversationToCodexRollout,
  type BridgeConversation,
  type CodexRolloutItem,
  type NormalizedMessage,
} from "agent-session-bridge-core";

export function discoverRolloutPath(
  sessionId: string,
  cwd: string,
  date = new Date(),
): string {
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${cwd}/.codex/sessions/${year}/${month}/${day}/rollout-${sessionId}.jsonl`;
}

export function buildExperimentalRollout(
  messages: NormalizedMessage[],
  cwd: string,
  sessionId: string,
): CodexRolloutItem[] {
  return convertConversationToCodexRollout(messages, cwd, sessionId);
}

export interface CodexHookPayload {
  session_id?: string;
  cwd?: string;
}

export function parseCodexHookPayload(raw: string): CodexHookPayload {
  return JSON.parse(raw) as CodexHookPayload;
}

export function registerCodexMirror(
  conversation: BridgeConversation,
  sessionId: string,
  rolloutPath: string,
  updatedAt: string,
): BridgeConversation {
  return attachMirror(
    conversation,
    "codex",
    {
      nativeId: sessionId,
      sessionPath: rolloutPath,
    },
    updatedAt,
  );
}
