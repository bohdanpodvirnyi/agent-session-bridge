import {
  oneShotBackfill,
  type BackfillCandidate,
  type BackfillResult,
  type BridgeConversation,
} from "agent-session-bridge-core";

export function runOneShotBackfill(
  candidates: BackfillCandidate[],
  linkedConversation?: BridgeConversation,
): BackfillResult {
  return oneShotBackfill(candidates, linkedConversation);
}
