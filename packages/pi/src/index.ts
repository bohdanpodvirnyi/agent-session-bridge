import {
  attachMirror,
  type BridgeConversation,
  type PiSessionEntry,
} from "agent-session-bridge-core";

export interface PiSessionStartContext {
  bridgeConversation: BridgeConversation;
  mirrorSessionId: string;
  mirrorPath: string;
  timestamp: string;
}

export function handleSessionStart(
  context: PiSessionStartContext,
): BridgeConversation {
  return attachMirror(
    context.bridgeConversation,
    "claude",
    {
      nativeId: context.mirrorSessionId,
      sessionPath: context.mirrorPath,
    },
    context.timestamp,
  );
}

export function handleMessageEnd(entry: PiSessionEntry): PiSessionEntry {
  return entry;
}

export interface PiBridgeState {
  mirrorSessionId: string;
  mirrorPath: string;
  updatedAt: string;
}

export function serializePiBridgeState(state: PiBridgeState): string {
  return JSON.stringify(state);
}

export function restorePiBridgeState(raw: string): PiBridgeState {
  return JSON.parse(raw) as PiBridgeState;
}
