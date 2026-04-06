import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  attachMirror,
  convertConversationToCodexRollout,
  importLatestSessionToTarget,
  isProjectEnabled,
  loadBridgeConfig,
  readCodexRollout,
  shouldSyncDirection,
  syncSourceSessionToTargets,
  type BridgeConversation,
  type CodexRolloutItem,
  type NormalizedMessage,
  type SyncSourceSessionResult,
} from "../../core/src/index.js";

export function discoverRolloutPath(
  sessionId: string,
  date = new Date(),
  codexHome = join(homedir(), ".codex"),
): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const stamp = [
    `${year}-${month}-${day}`,
    [
      String(date.getHours()).padStart(2, "0"),
      String(date.getMinutes()).padStart(2, "0"),
      String(date.getSeconds()).padStart(2, "0"),
    ].join("-"),
  ].join("T");
  return join(
    codexHome,
    "sessions",
    year,
    month,
    day,
    `rollout-${stamp}-${sessionId}.jsonl`,
  );
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
  transcript_path?: string;
}

export function parseCodexHookPayload(raw: string): CodexHookPayload {
  return JSON.parse(raw) as CodexHookPayload;
}

export interface CodexRuntimeOptions {
  homeDir?: string;
  registryPath?: string;
  now?: Date;
}

async function walkJsonlFiles(root: string): Promise<string[]> {
  const queue = [root];
  const files: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    try {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(current, entry.name);
        if (entry.isDirectory()) {
          queue.push(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          files.push(fullPath);
        }
      }
    } catch {
      continue;
    }
  }

  return files.sort();
}

async function findRolloutPath(
  sessionId: string,
  homeDir: string,
): Promise<string | null> {
  const root = join(homeDir, ".codex", "sessions");
  const files = await walkJsonlFiles(root);
  const filenameMatch = files.find((path) => path.includes(sessionId));
  if (filenameMatch) {
    return filenameMatch;
  }

  for (const path of files) {
    try {
      const items = await readCodexRollout(path);
      const sessionMeta = items.find((item) => item.type === "session_meta");
      if (sessionMeta?.payload.id === sessionId) {
        return path;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function resolveRegistryPath(homeDir: string): string {
  return join(homeDir, ".agent-session-bridge", "registry.json");
}

export async function runCodexSessionStart(
  payload: CodexHookPayload,
  options: CodexRuntimeOptions = {},
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
    targetTool: "codex",
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

export async function runCodexStop(
  payload: CodexHookPayload,
  options: CodexRuntimeOptions = {},
): Promise<{
  synced: boolean;
  rolloutPath: string | null;
  result?: SyncSourceSessionResult;
}> {
  const homeDir = options.homeDir ?? homedir();
  const config = await loadBridgeConfig(
    join(homeDir, ".agent-session-bridge", "config.json"),
    {
      readFile,
    },
  );
  if (!payload.cwd || !isProjectEnabled(config, payload.cwd)) {
    return { synced: false, rolloutPath: null };
  }
  const targetTools = (["pi", "claude"] as const).filter((tool) =>
    shouldSyncDirection(config, "codex", tool),
  );
  if (targetTools.length === 0) {
    return { synced: false, rolloutPath: null };
  }
  const rolloutPath =
    payload.transcript_path ??
    (payload.session_id
      ? await findRolloutPath(payload.session_id, homeDir)
      : null);

  if (!rolloutPath) {
    return { synced: false, rolloutPath: null };
  }

  const result = await syncSourceSessionToTargets({
    sourceTool: "codex",
    sourcePath: rolloutPath,
    sourceSessionId: payload.session_id,
    registryPath: options.registryPath ?? resolveRegistryPath(homeDir),
    homeDir,
    now: options.now,
    targetTools,
  });

  return {
    synced: true,
    rolloutPath,
    result,
  };
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
