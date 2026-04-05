import { readFile } from "node:fs/promises";

import {
  attachMirror,
  importLatestSessionToTarget,
  isProjectEnabled,
  loadBridgeConfig,
  shouldSyncDirection,
  syncSourceSessionToTargets,
  type BridgeConversation,
  type PiSessionEntry,
  type SyncSourceSessionResult,
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

export interface PiRuntimeOptions {
  homeDir: string;
  registryPath: string;
  now?: Date;
  cwd?: string;
}

export async function runPiSessionImport(
  cwd: string,
  options: PiRuntimeOptions,
): Promise<{
  imported: boolean;
  result?: SyncSourceSessionResult;
}> {
  const config = await loadBridgeConfig(
    `${options.homeDir}/.agent-session-bridge/config.json`,
    {
      readFile,
    },
  );
  if (!isProjectEnabled(config, cwd)) {
    return { imported: false };
  }

  const imported = await importLatestSessionToTarget({
    targetTool: "pi",
    cwd,
    homeDir: options.homeDir,
    registryPath: options.registryPath,
    now: options.now,
  });

  return {
    imported: imported.imported,
    result: imported.result,
  };
}

export async function runPiMessageSync(
  sessionFile: string,
  sessionId: string,
  options: PiRuntimeOptions,
): Promise<SyncSourceSessionResult> {
  const config = await loadBridgeConfig(
    `${options.homeDir}/.agent-session-bridge/config.json`,
    {
      readFile,
    },
  );
  if (options.cwd && !isProjectEnabled(config, options.cwd)) {
    return syncSourceSessionToTargets({
      sourceTool: "pi",
      sourcePath: sessionFile,
      sourceSessionId: sessionId,
      registryPath: options.registryPath,
      homeDir: options.homeDir,
      now: options.now,
      targetTools: [],
    });
  }

  const targetTools = (["claude", "codex"] as const).filter((tool) =>
    shouldSyncDirection(config, "pi", tool),
  );
  return syncSourceSessionToTargets({
    sourceTool: "pi",
    sourcePath: sessionFile,
    sourceSessionId: sessionId,
    registryPath: options.registryPath,
    homeDir: options.homeDir,
    now: options.now,
    targetTools,
  });
}
