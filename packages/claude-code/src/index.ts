import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  chooseResumeCandidate,
  importLatestSessionToTarget,
  isProjectEnabled,
  loadBridgeConfig,
  markConversationConflicted,
  shouldSyncDirection,
  syncSourceSessionToTargets,
  type BridgeConversation,
  type ClaudeCodeLine,
  type SessionCandidate,
  type SyncSourceSessionResult,
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

export interface ClaudeRuntimeOptions {
  homeDir?: string;
  registryPath?: string;
  now?: Date;
}

function resolveRegistryPath(homeDir: string): string {
  return join(homeDir, ".agent-session-bridge", "registry.json");
}

export async function runClaudeSessionStart(
  payload: ClaudeHookPayload,
  options: ClaudeRuntimeOptions = {},
): Promise<{
  imported: boolean;
  candidateId: string | null;
  result?: SyncSourceSessionResult;
}> {
  if (!payload.cwd) {
    return { imported: false, candidateId: null };
  }

  const homeDir = options.homeDir ?? homedir();
  const config = await loadBridgeConfig(
    join(homeDir, ".agent-session-bridge", "config.json"),
    {
      readFile,
    },
  );
  if (!isProjectEnabled(config, payload.cwd)) {
    return { imported: false, candidateId: null };
  }
  const imported = await importLatestSessionToTarget({
    targetTool: "claude",
    cwd: payload.cwd,
    homeDir,
    registryPath: options.registryPath ?? resolveRegistryPath(homeDir),
    now: options.now,
  });

  return {
    imported: imported.imported,
    candidateId: imported.candidate?.id ?? null,
    result: imported.result,
  };
}

export async function runClaudeStop(
  payload: ClaudeHookPayload,
  options: ClaudeRuntimeOptions = {},
): Promise<{
  synced: boolean;
  result?: SyncSourceSessionResult;
}> {
  if (!payload.transcript_path) {
    return { synced: false };
  }

  const homeDir = options.homeDir ?? homedir();
  const config = await loadBridgeConfig(
    join(homeDir, ".agent-session-bridge", "config.json"),
    {
      readFile,
    },
  );
  if (!payload.cwd || !isProjectEnabled(config, payload.cwd)) {
    return { synced: false };
  }
  const targetTools = (["pi", "codex"] as const).filter((tool) =>
    shouldSyncDirection(config, "claude", tool),
  );
  if (targetTools.length === 0) {
    return { synced: false };
  }
  const result = await syncSourceSessionToTargets({
    sourceTool: "claude",
    sourcePath: payload.transcript_path,
    sourceSessionId: payload.session_id,
    registryPath: options.registryPath ?? resolveRegistryPath(homeDir),
    homeDir,
    now: options.now,
    targetTools,
  });

  return {
    synced: true,
    result,
  };
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
