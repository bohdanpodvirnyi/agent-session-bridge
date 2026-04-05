import type { BridgeConversation } from "./types.js";

export interface SessionCandidate {
  id: string;
  updatedAt: string;
  sourceTool: "pi" | "claude" | "codex";
  path: string;
}

export function selectImportCandidate(
  candidates: SessionCandidate[],
  linkedConversation?: BridgeConversation,
): SessionCandidate | null {
  if (linkedConversation) {
    const linked = candidates.find((candidate) =>
      Object.values(linkedConversation.mirrors).some(
        (mirror) => mirror?.nativeId === candidate.id,
      ),
    );
    if (linked) {
      return linked;
    }
  }

  return (
    [...candidates].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    )[0] ?? null
  );
}
