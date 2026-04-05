import { chooseResumeCandidate } from "./sync.js";
import type { BridgeConversation } from "./types.js";

export interface BackfillCandidate {
  id: string;
  path: string;
  sourceTool: "pi" | "claude" | "codex";
  updatedAt: string;
}

export interface BackfillResult {
  selected: BackfillCandidate | null;
  reusedRegistryLogic: true;
}

export function oneShotBackfill(
  candidates: BackfillCandidate[],
  linkedConversation?: BridgeConversation,
): BackfillResult {
  return {
    selected: chooseResumeCandidate(candidates, linkedConversation),
    reusedRegistryLogic: true,
  };
}

export function startWatchMode(onTick: () => void): { stop(): void } {
  let active = true;
  if (active) {
    onTick();
  }

  return {
    stop() {
      active = false;
    },
  };
}
