import { createHash } from "node:crypto";

import type { SyncWatermark } from "./types.js";

export interface SyncChunk {
  sourceTool: SyncWatermark["sourceTool"];
  sourceSessionId: string;
  sourceOffset: number;
  targetTool: SyncWatermark["targetTool"];
  targetSessionId: string;
  targetOffset: number;
  content: string;
}

export interface SyncDecision {
  apply: boolean;
  reason: "new" | "duplicate" | "stale-target";
  watermark: SyncWatermark;
}

export function hashSyncContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function decideSyncChunk(
  watermarks: SyncWatermark[],
  chunk: SyncChunk,
): SyncDecision {
  const watermark: SyncWatermark = {
    sourceTool: chunk.sourceTool,
    sourceSessionId: chunk.sourceSessionId,
    sourceOffset: chunk.sourceOffset,
    targetTool: chunk.targetTool,
    targetSessionId: chunk.targetSessionId,
    targetOffset: chunk.targetOffset,
    contentHash: hashSyncContent(chunk.content),
  };

  const matching = watermarks.find(
    (item) =>
      item.sourceTool === watermark.sourceTool &&
      item.sourceSessionId === watermark.sourceSessionId &&
      item.sourceOffset === watermark.sourceOffset &&
      item.targetTool === watermark.targetTool &&
      item.targetSessionId === watermark.targetSessionId &&
      item.contentHash === watermark.contentHash,
  );

  if (matching) {
    return { apply: false, reason: "duplicate", watermark: matching };
  }

  const staleTarget = watermarks.find(
    (item) =>
      item.sourceTool === watermark.sourceTool &&
      item.sourceSessionId === watermark.sourceSessionId &&
      item.targetTool === watermark.targetTool &&
      item.targetSessionId === watermark.targetSessionId &&
      item.targetOffset > watermark.targetOffset,
  );

  if (staleTarget) {
    return { apply: false, reason: "stale-target", watermark };
  }

  return { apply: true, reason: "new", watermark };
}

export function applySyncDecision(
  watermarks: SyncWatermark[],
  decision: SyncDecision,
): SyncWatermark[] {
  if (!decision.apply) {
    return watermarks;
  }

  const filtered = watermarks.filter(
    (item) =>
      !(
        item.sourceTool === decision.watermark.sourceTool &&
        item.sourceSessionId === decision.watermark.sourceSessionId &&
        item.sourceOffset === decision.watermark.sourceOffset &&
        item.targetTool === decision.watermark.targetTool &&
        item.targetSessionId === decision.watermark.targetSessionId
      ),
  );

  return reconcileWatermarks([...filtered, decision.watermark]);
}

export function reconcileWatermarks(
  watermarks: SyncWatermark[],
): SyncWatermark[] {
  const byKey = new Map<string, SyncWatermark>();

  for (const watermark of watermarks) {
    const key = [
      watermark.sourceTool,
      watermark.sourceSessionId,
      watermark.sourceOffset,
      watermark.targetTool,
      watermark.targetSessionId,
      watermark.contentHash,
    ].join(":");
    const existing = byKey.get(key);

    if (!existing || watermark.targetOffset >= existing.targetOffset) {
      byKey.set(key, watermark);
    }
  }

  return [...byKey.values()].sort(
    (left, right) => left.sourceOffset - right.sourceOffset,
  );
}
