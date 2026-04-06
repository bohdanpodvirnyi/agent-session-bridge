import {
  oneShotBackfill,
  type BackfillCandidate,
  type BackfillResult,
  type BridgeConversation,
} from "../../core/src/index.js";

export function runOneShotBackfill(
  candidates: BackfillCandidate[],
  linkedConversation?: BridgeConversation,
): BackfillResult {
  return oneShotBackfill(candidates, linkedConversation);
}
