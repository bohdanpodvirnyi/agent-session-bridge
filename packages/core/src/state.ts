import { join } from "node:path";

export interface ConversationState {
  bridgeSessionId: string;
  lastSyncedAt?: string;
}

export function getConversationStatePath(
  baseDir: string,
  bridgeSessionId: string,
): string {
  return join(baseDir, "state", `${bridgeSessionId}.json`);
}

export function createConversationState(
  bridgeSessionId: string,
): ConversationState {
  return {
    bridgeSessionId,
  };
}
