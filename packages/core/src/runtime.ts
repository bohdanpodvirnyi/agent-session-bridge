import {
  access,
  appendFile,
  mkdir,
  realpath,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

import {
  convertClaudeLineToNormalized,
  convertCodexItemToNormalized,
  convertNormalizedToClaudeLine,
  convertNormalizedToPiEntry,
  convertPiEntryToNormalized,
} from "./converters.js";
import { selectImportCandidate, type SessionCandidate } from "./discovery.js";
import { decideSyncChunk, applySyncDecision } from "./dedupe.js";
import {
  deriveProjectKey,
  dirname,
  findGitRepoRoot,
  getClaudeCodeProjectDir,
  getCodexSessionDir,
  getPiSessionDir,
  normalizePath,
} from "./path-utils.js";
import {
  readClaudeCodeSession,
  readCodexRollout,
  readPiSession,
} from "./parsers.js";
import {
  emptyRegistry,
  findConversationsByProjectKey,
  findConversationByNativeSession,
  loadRegistry,
  saveRegistry,
  upsertConversation,
} from "./registry.js";
import { convertConversationToCodexRollout } from "./sync.js";
import type {
  BridgeConversation,
  BridgeRegistry,
  ClaudeCodeLine,
  CodexRolloutItem,
  NormalizedMessage,
  PiSessionEntry,
  PiSessionHeader,
  ToolMirror,
  ToolName,
} from "./types.js";

export interface SourceMessageChunk {
  sourceOffset: number;
  message: NormalizedMessage;
}

export interface SourceSessionSnapshot {
  sourceTool: ToolName;
  sourcePath: string;
  sourceSessionId: string;
  cwd: string;
  updatedAt: string;
  chunks: SourceMessageChunk[];
}

export interface SyncWriteResult {
  targetTool: ToolName;
  sessionPath: string;
  targetSessionId: string;
  appendedCount: number;
}

export interface SyncSourceSessionResult {
  conversation: BridgeConversation;
  registry: BridgeRegistry;
  writes: SyncWriteResult[];
  snapshot: SourceSessionSnapshot;
}

function formatSessionStamp(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function formatCodexRolloutStamp(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}-${minutes}-${seconds}`;
}

function deterministicHex(seed: string): string {
  return createHash("sha1").update(seed).digest("hex");
}

function deterministicUuid(seed: string): string {
  const hex = deterministicHex(seed).slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function deterministicPiId(seed: string): string {
  return deterministicHex(seed).slice(0, 8);
}

function formatUuidBytes(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

export function generateCodexThreadId(date = new Date()): string {
  const bytes = randomBytes(16);
  const timestamp = BigInt(date.getTime());

  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);

  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  return formatUuidBytes(bytes);
}

export function isCodexThreadId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function walkJsonlFiles(root: string): Promise<string[]> {
  if (!(await exists(root))) {
    return [];
  }

  const queue = [root];
  const files: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  }

  return files.sort();
}

async function appendJsonLines(path: string, items: unknown[]): Promise<void> {
  if (items.length === 0) {
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await appendFile(
    path,
    `${items.map((item) => JSON.stringify(item)).join("\n")}\n`,
    "utf8",
  );
}

function getPiEntryTimestamp(entry: PiSessionEntry): string | undefined {
  return entry.timestamp;
}

function getClaudeLineTimestamp(line: ClaudeCodeLine): string | undefined {
  return line.timestamp;
}

function getCodexItemTimestamp(item: CodexRolloutItem): string | undefined {
  const payloadTimestamp =
    typeof item.payload.timestamp === "string" ? item.payload.timestamp : null;
  return (
    ((item as { timestamp?: unknown }).timestamp as string | undefined) ??
    payloadTimestamp ??
    undefined
  );
}

function createPiHeader(
  cwd: string,
  sessionId: string,
  timestamp: string,
): PiSessionHeader {
  return {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp,
    cwd,
  };
}

async function loadTargetClaudeState(path: string): Promise<{
  count: number;
  lastUuid: string | null;
}> {
  if (!(await exists(path))) {
    return { count: 0, lastUuid: null };
  }

  const lines = await readClaudeCodeSession(path);
  let lastUuid: string | null = null;
  for (const line of lines) {
    if (typeof line.uuid === "string") {
      lastUuid = line.uuid;
    }
  }
  return { count: lines.length, lastUuid };
}

async function loadTargetPiState(path: string): Promise<{
  count: number;
  lastId: string | null;
}> {
  if (!(await exists(path))) {
    return { count: 0, lastId: null };
  }

  const session = await readPiSession(path);
  const last = session.entries[session.entries.length - 1];
  return {
    count: session.entries.length,
    lastId: typeof last?.id === "string" ? last.id : null,
  };
}

async function loadTargetCodexState(path: string): Promise<{
  count: number;
  hasMeta: boolean;
}> {
  if (!(await exists(path))) {
    return { count: 0, hasMeta: false };
  }

  const items = await readCodexRollout(path);
  return {
    count: items.length,
    hasMeta: items.some((item) => item.type === "session_meta"),
  };
}

export async function loadSourceSessionSnapshot(
  sourceTool: ToolName,
  sourcePath: string,
  explicitSessionId?: string,
): Promise<SourceSessionSnapshot> {
  const info = await stat(sourcePath);

  if (sourceTool === "pi") {
    const session = await readPiSession(sourcePath);
    return {
      sourceTool,
      sourcePath,
      sourceSessionId: explicitSessionId ?? session.header.id,
      cwd: session.header.cwd,
      updatedAt:
        session.entries.at(-1)?.timestamp ??
        session.header.timestamp ??
        info.mtime.toISOString(),
      chunks: session.entries.flatMap((entry, index) => {
        const normalized = convertPiEntryToNormalized(entry);
        return normalized
          ? [{ sourceOffset: index + 1, message: normalized }]
          : [];
      }),
    };
  }

  if (sourceTool === "claude") {
    const lines = await readClaudeCodeSession(sourcePath);
    const sourceSessionId =
      explicitSessionId ??
      lines.find((line) => typeof line.sessionId === "string")?.sessionId ??
      deterministicUuid(sourcePath);
    const cwd = lines.find((line) => typeof line.cwd === "string")?.cwd ?? "/";
    const timestamps = lines
      .map((line) => getClaudeLineTimestamp(line))
      .filter((value): value is string => Boolean(value));

    return {
      sourceTool,
      sourcePath,
      sourceSessionId,
      cwd,
      updatedAt: timestamps.at(-1) ?? info.mtime.toISOString(),
      chunks: lines.flatMap((line, index) => {
        const normalized = convertClaudeLineToNormalized(line);
        return normalized
          ? [{ sourceOffset: index + 1, message: normalized }]
          : [];
      }),
    };
  }

  const items = await readCodexRollout(sourcePath);
  const sessionMeta = items.find((item) => item.type === "session_meta");
  const sourceSessionId =
    explicitSessionId ??
    (typeof sessionMeta?.payload.id === "string"
      ? sessionMeta.payload.id
      : undefined) ??
    deterministicUuid(sourcePath);
  const cwd =
    (typeof sessionMeta?.payload.cwd === "string"
      ? sessionMeta.payload.cwd
      : undefined) ?? "/";
  const timestamps = items
    .map((item) => getCodexItemTimestamp(item))
    .filter((value): value is string => Boolean(value));

  return {
    sourceTool,
    sourcePath,
    sourceSessionId,
    cwd,
    updatedAt: timestamps.at(-1) ?? info.mtime.toISOString(),
    chunks: items.flatMap((item, index) => {
      const normalized = convertCodexItemToNormalized(item);
      return normalized
        ? [{ sourceOffset: index + 1, message: normalized }]
        : [];
    }),
  };
}

function createConversation(
  projectKey: string,
  canonicalCwd: string,
  sourceTool: ToolName,
  sourceSessionId: string,
  sourcePath: string,
  now: string,
): BridgeConversation {
  return {
    bridgeSessionId: randomUUID(),
    projectKey,
    canonicalCwd,
    createdAt: now,
    updatedAt: now,
    status: "active",
    lastOriginTool: sourceTool,
    mirrors: {
      [sourceTool]: {
        nativeId: sourceSessionId,
        sessionPath: sourcePath,
      },
    },
    lastWrittenOffsets: [],
  };
}

function attachSourceMirror(
  conversation: BridgeConversation,
  sourceTool: ToolName,
  sourceSessionId: string,
  sourcePath: string,
  updatedAt: string,
): BridgeConversation {
  return {
    ...conversation,
    updatedAt,
    lastOriginTool: sourceTool,
    mirrors: {
      ...conversation.mirrors,
      [sourceTool]: {
        nativeId: sourceSessionId,
        sessionPath: sourcePath,
      },
    },
  };
}

function makeMirrorMessage(
  message: NormalizedMessage,
  sourceTool: ToolName,
  sourceSessionId: string,
  sourceOffset: number,
  targetTool: ToolName,
): NormalizedMessage {
  const seed = `${sourceTool}:${sourceSessionId}:${sourceOffset}:${targetTool}`;
  return {
    ...message,
    id: targetTool === "pi" ? deterministicPiId(seed) : deterministicUuid(seed),
  };
}

async function ensureTargetMirror(
  conversation: BridgeConversation,
  targetTool: ToolName,
  homeDir: string,
  now: Date,
): Promise<ToolMirror> {
  const existing = conversation.mirrors[targetTool];
  if (
    existing &&
    (targetTool !== "codex" || isCodexThreadId(existing.nativeId))
  ) {
    return existing;
  }

  if (targetTool === "pi") {
    const sessionId = randomUUID();
    const path = join(
      getPiSessionDir(conversation.projectKey, homeDir),
      `${formatSessionStamp(now)}_${sessionId}.jsonl`,
    );
    return { nativeId: sessionId, sessionPath: path };
  }

  if (targetTool === "claude") {
    const sessionId = randomUUID();
    const path = join(
      getClaudeCodeProjectDir(conversation.projectKey, homeDir),
      `${sessionId}.jsonl`,
    );
    return { nativeId: sessionId, sessionPath: path };
  }

  const sessionId = generateCodexThreadId(now);
  const path = join(
    getCodexSessionDir(now, homeDir),
    `rollout-${formatCodexRolloutStamp(now)}-${sessionId}.jsonl`,
  );
  return { nativeId: sessionId, sessionPath: path };
}

async function appendToPiMirror(
  mirror: ToolMirror,
  cwd: string,
  sourceTool: ToolName,
  sourceSessionId: string,
  chunks: SourceMessageChunk[],
  watermarks: BridgeConversation["lastWrittenOffsets"],
): Promise<{
  appendedCount: number;
  nextWatermarks: BridgeConversation["lastWrittenOffsets"];
  finalCount: number;
}> {
  let { count } = await loadTargetPiState(mirror.sessionPath);
  let nextWatermarks = watermarks;
  let appendedCount = 0;
  let previousMirrorId: string | null = null;

  if (!(await exists(mirror.sessionPath))) {
    await mkdir(dirname(mirror.sessionPath), { recursive: true });
    await writeFile(
      mirror.sessionPath,
      `${JSON.stringify(
        createPiHeader(cwd, mirror.nativeId, new Date().toISOString()),
      )}\n`,
      "utf8",
    );
  }

  for (const chunk of chunks) {
    const mirrorMessage = makeMirrorMessage(
      chunk.message,
      sourceTool,
      sourceSessionId,
      chunk.sourceOffset,
      "pi",
    );
    const entry = convertNormalizedToPiEntry(mirrorMessage, previousMirrorId);
    const content = JSON.stringify(entry);
    const decision = decideSyncChunk(nextWatermarks, {
      sourceTool,
      sourceSessionId,
      sourceOffset: chunk.sourceOffset,
      targetTool: "pi",
      targetSessionId: mirror.nativeId,
      targetOffset: count + 1,
      content,
    });

    if (!decision.apply) {
      previousMirrorId = mirrorMessage.id;
      continue;
    }

    await appendJsonLines(mirror.sessionPath, [entry]);
    appendedCount += 1;
    count += 1;
    nextWatermarks = applySyncDecision(nextWatermarks, decision);
    previousMirrorId = mirrorMessage.id;
  }

  return { appendedCount, nextWatermarks, finalCount: count };
}

async function appendToClaudeMirror(
  mirror: ToolMirror,
  cwd: string,
  sourceTool: ToolName,
  sourceSessionId: string,
  chunks: SourceMessageChunk[],
  watermarks: BridgeConversation["lastWrittenOffsets"],
): Promise<{
  appendedCount: number;
  nextWatermarks: BridgeConversation["lastWrittenOffsets"];
  finalCount: number;
}> {
  let { count } = await loadTargetClaudeState(mirror.sessionPath);
  let nextWatermarks = watermarks;
  let appendedCount = 0;
  let previousMirrorId: string | null = null;

  await mkdir(dirname(mirror.sessionPath), { recursive: true });

  for (const chunk of chunks) {
    const mirrorMessage = makeMirrorMessage(
      chunk.message,
      sourceTool,
      sourceSessionId,
      chunk.sourceOffset,
      "claude",
    );
    const line = convertNormalizedToClaudeLine(
      mirrorMessage,
      mirror.nativeId,
      previousMirrorId,
      cwd,
    );
    const content = JSON.stringify(line);
    const decision = decideSyncChunk(nextWatermarks, {
      sourceTool,
      sourceSessionId,
      sourceOffset: chunk.sourceOffset,
      targetTool: "claude",
      targetSessionId: mirror.nativeId,
      targetOffset: count + 1,
      content,
    });

    if (!decision.apply) {
      previousMirrorId = mirrorMessage.id;
      continue;
    }

    await appendJsonLines(mirror.sessionPath, [line]);
    appendedCount += 1;
    count += 1;
    nextWatermarks = applySyncDecision(nextWatermarks, decision);
    previousMirrorId = mirrorMessage.id;
  }

  return { appendedCount, nextWatermarks, finalCount: count };
}

async function appendToCodexMirror(
  mirror: ToolMirror,
  cwd: string,
  sourceTool: ToolName,
  sourceSessionId: string,
  chunks: SourceMessageChunk[],
  watermarks: BridgeConversation["lastWrittenOffsets"],
): Promise<{
  appendedCount: number;
  nextWatermarks: BridgeConversation["lastWrittenOffsets"];
  finalCount: number;
}> {
  let { count, hasMeta } = await loadTargetCodexState(mirror.sessionPath);
  let nextWatermarks = watermarks;
  let appendedCount = 0;

  await mkdir(dirname(mirror.sessionPath), { recursive: true });

  if (!hasMeta && chunks.length > 0) {
    const [sessionMeta] = convertConversationToCodexRollout(
      [chunks[0]!.message],
      cwd,
      mirror.nativeId,
      {
        includeSessionMeta: true,
      },
    );

    if (sessionMeta) {
      await appendJsonLines(mirror.sessionPath, [
        {
          timestamp: chunks[0]!.message.timestamp,
          ...sessionMeta,
        },
      ]);
      count += 1;
      appendedCount += 1;
      hasMeta = true;
    }
  }

  for (const chunk of chunks) {
    const mirrorMessage = makeMirrorMessage(
      chunk.message,
      sourceTool,
      sourceSessionId,
      chunk.sourceOffset,
      "codex",
    );
    const lines = convertConversationToCodexRollout(
      [mirrorMessage],
      cwd,
      mirror.nativeId,
      {
        includeSessionMeta: false,
      },
    ).map((item) => ({
      timestamp: chunk.message.timestamp,
      ...item,
    }));

    const content = lines.map((line) => JSON.stringify(line)).join("\n");
    const decision = decideSyncChunk(nextWatermarks, {
      sourceTool,
      sourceSessionId,
      sourceOffset: chunk.sourceOffset,
      targetTool: "codex",
      targetSessionId: mirror.nativeId,
      targetOffset: count + lines.length,
      content,
    });

    if (!decision.apply) {
      continue;
    }

    await appendJsonLines(mirror.sessionPath, lines);
    appendedCount += lines.length;
    count += lines.length;
    hasMeta = true;
    nextWatermarks = applySyncDecision(nextWatermarks, decision);
  }

  return { appendedCount, nextWatermarks, finalCount: count };
}

export async function syncSourceSessionToTargets(params: {
  sourceTool: ToolName;
  sourcePath: string;
  sourceSessionId?: string;
  registryPath: string;
  homeDir: string;
  now?: Date;
  targetTools?: ToolName[];
}): Promise<SyncSourceSessionResult> {
  const now = params.now ?? new Date();
  const snapshot = await loadSourceSessionSnapshot(
    params.sourceTool,
    params.sourcePath,
    params.sourceSessionId,
  );
  const registry = await loadRegistry(params.registryPath, { readFile });
  const { canonicalCwd, projectKey } = await deriveProjectKey(snapshot.cwd, {
    realpath,
    findRepoRoot: async (cwd) =>
      findGitRepoRoot(cwd, {
        exists,
      }),
  });

  let conversation =
    findConversationByNativeSession(
      registry,
      params.sourceTool,
      snapshot.sourceSessionId,
    ) ??
    createConversation(
      projectKey,
      canonicalCwd,
      params.sourceTool,
      snapshot.sourceSessionId,
      params.sourcePath,
      now.toISOString(),
    );

  const seededSourceOffset =
    conversation.mirrors[params.sourceTool]?.nativeId === snapshot.sourceSessionId
      ? conversation.mirrors[params.sourceTool]?.seededSourceOffset
      : undefined;
  const sourceChunks =
    typeof seededSourceOffset === "number"
      ? snapshot.chunks.filter((chunk) => chunk.sourceOffset > seededSourceOffset)
      : snapshot.chunks;

  conversation = attachSourceMirror(
    conversation,
    params.sourceTool,
    snapshot.sourceSessionId,
    params.sourcePath,
    snapshot.updatedAt,
  );

  const targetTools = (params.targetTools ?? ["pi", "claude", "codex"]).filter(
    (tool) => tool !== params.sourceTool,
  );
  const writes: SyncWriteResult[] = [];

  for (const targetTool of targetTools) {
    const mirror = await ensureTargetMirror(
      conversation,
      targetTool,
      params.homeDir,
      now,
    );
    conversation = {
      ...conversation,
      mirrors: {
        ...conversation.mirrors,
        [targetTool]: mirror,
      },
    };

    const writeResult =
      targetTool === "pi"
        ? await appendToPiMirror(
            mirror,
            snapshot.cwd,
            params.sourceTool,
            snapshot.sourceSessionId,
            sourceChunks,
            conversation.lastWrittenOffsets,
          )
        : targetTool === "claude"
          ? await appendToClaudeMirror(
              mirror,
              snapshot.cwd,
              params.sourceTool,
              snapshot.sourceSessionId,
              sourceChunks,
              conversation.lastWrittenOffsets,
            )
          : await appendToCodexMirror(
              mirror,
              snapshot.cwd,
              params.sourceTool,
              snapshot.sourceSessionId,
              sourceChunks,
              conversation.lastWrittenOffsets,
            );

    conversation = {
      ...conversation,
      lastWrittenOffsets: writeResult.nextWatermarks,
      updatedAt: snapshot.updatedAt,
      mirrors:
        mirror.seededSourceOffset == null
          ? {
              ...conversation.mirrors,
              [targetTool]: {
                ...mirror,
                seededSourceOffset: writeResult.finalCount,
              },
            }
          : conversation.mirrors,
    };

    writes.push({
      targetTool,
      sessionPath: mirror.sessionPath,
      targetSessionId: mirror.nativeId,
      appendedCount: writeResult.appendedCount,
    });
  }

  const nextRegistry = upsertConversation(registry, conversation);
  await saveRegistry(params.registryPath, nextRegistry, {
    mkdir: async (path, options) => {
      await mkdir(path, options);
    },
    writeFile: async (path, data) => {
      await writeFile(path, data, "utf8");
    },
    rename: async (from, to) => {
      const content = await readFile(from, "utf8");
      await writeFile(to, content, "utf8");
    },
  });

  return {
    conversation,
    registry: nextRegistry,
    writes,
    snapshot,
  };
}

async function readCandidateCwd(
  tool: ToolName,
  path: string,
): Promise<string | null> {
  try {
    if (tool === "pi") {
      return (await readPiSession(path)).header.cwd;
    }
    if (tool === "claude") {
      const lines = await readClaudeCodeSession(path);
      return lines.find((line) => typeof line.cwd === "string")?.cwd ?? null;
    }
    const items = await readCodexRollout(path);
    const meta = items.find((item) => item.type === "session_meta");
    return typeof meta?.payload.cwd === "string" ? meta.payload.cwd : null;
  } catch {
    return null;
  }
}

function isSessionCandidate(
  candidate: SessionCandidate | null,
): candidate is SessionCandidate {
  return candidate !== null;
}

async function canonicalizeForComparison(path: string): Promise<string> {
  try {
    return normalizePath(await realpath(path));
  } catch {
    return normalizePath(path);
  }
}

async function belongsToProject(
  candidateCwd: string,
  projectKey: string,
): Promise<boolean> {
  const normalizedProject = await canonicalizeForComparison(projectKey);
  const normalizedCandidate = await canonicalizeForComparison(candidateCwd);

  return (
    normalizedCandidate === normalizedProject ||
    normalizedCandidate.startsWith(`${normalizedProject}/`)
  );
}

export async function listSessionCandidatesForProject(
  tool: ToolName,
  projectKey: string,
  homeDir: string,
): Promise<SessionCandidate[]> {
  const canonicalProjectKey = await canonicalizeForComparison(projectKey);

  if (tool === "pi") {
    const files = await walkJsonlFiles(
      join(homeDir, ".pi", "agent", "sessions"),
    );
    const candidates = (
      await Promise.all(
        files.map(async (path): Promise<SessionCandidate | null> => {
          const session = await readPiSession(path);
          if (
            !(await belongsToProject(session.header.cwd, canonicalProjectKey))
          ) {
            return null;
          }
          return {
            id: session.header.id,
            path,
            sourceTool: "pi",
            updatedAt:
              session.entries.at(-1)?.timestamp ?? session.header.timestamp,
          };
        }),
      )
    )
      .filter(isSessionCandidate)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return candidates;
  }

  if (tool === "claude") {
    const files = await walkJsonlFiles(join(homeDir, ".claude", "projects"));
    const candidates = (
      await Promise.all(
        files.map(async (path): Promise<SessionCandidate | null> => {
          const cwd = await readCandidateCwd("claude", path);
          if (!cwd || !(await belongsToProject(cwd, canonicalProjectKey))) {
            return null;
          }
          const lines = await readClaudeCodeSession(path);
          return {
            id:
              lines.find((line) => typeof line.sessionId === "string")
                ?.sessionId ?? deterministicUuid(path),
            path,
            sourceTool: "claude",
            updatedAt:
              lines
                .map((line) => getClaudeLineTimestamp(line))
                .filter((value): value is string => Boolean(value))
                .at(-1) ?? new Date(0).toISOString(),
          };
        }),
      )
    )
      .filter(isSessionCandidate)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return candidates;
  }

  const files = await walkJsonlFiles(join(homeDir, ".codex", "sessions"));
  const candidates = (
    await Promise.all(
      files.map(async (path): Promise<SessionCandidate | null> => {
        const cwd = await readCandidateCwd("codex", path);
        if (!cwd || !(await belongsToProject(cwd, canonicalProjectKey))) {
          return null;
        }
        const items = await readCodexRollout(path);
        const meta = items.find((item) => item.type === "session_meta");
        return {
          id:
            (typeof meta?.payload.id === "string"
              ? meta.payload.id
              : undefined) ?? deterministicUuid(path),
          path,
          sourceTool: "codex",
          updatedAt:
            items
              .map((item) => getCodexItemTimestamp(item))
              .filter((value): value is string => Boolean(value))
              .at(-1) ?? new Date(0).toISOString(),
        };
      }),
    )
  )
    .filter(isSessionCandidate)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  return candidates;
}

export async function listForeignSessionCandidates(
  projectKey: string,
  homeDir: string,
  targetTool?: ToolName,
): Promise<SessionCandidate[]> {
  const tools: ToolName[] = ["pi", "claude", "codex"];
  const groups = await Promise.all(
    tools
      .filter((tool) => tool !== targetTool)
      .map((tool) =>
        listSessionCandidatesForProject(tool, projectKey, homeDir),
      ),
  );

  return groups
    .flat()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function importLatestSessionToTarget(params: {
  targetTool: ToolName;
  cwd: string;
  homeDir: string;
  registryPath: string;
  now?: Date;
}): Promise<{
  imported: boolean;
  candidate: SessionCandidate | null;
  result?: SyncSourceSessionResult;
}> {
  const { projectKey } = await deriveProjectKey(params.cwd, {
    realpath,
    findRepoRoot: async (cwd) =>
      findGitRepoRoot(cwd, {
        exists,
      }),
  });
  const registry = await loadRegistry(params.registryPath, { readFile });
  const linkedConversations = findConversationsByProjectKey(registry, projectKey)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const linkedConversation =
    linkedConversations.length === 1 ? linkedConversations[0] : undefined;
  const candidates = await listForeignSessionCandidates(
    projectKey,
    params.homeDir,
    params.targetTool,
  );
  const candidate = selectImportCandidate(candidates, linkedConversation);

  if (!candidate) {
    return { imported: false, candidate: null };
  }

  const result = await syncSourceSessionToTargets({
    sourceTool: candidate.sourceTool,
    sourcePath: candidate.path,
    sourceSessionId: candidate.id,
    registryPath: params.registryPath,
    homeDir: params.homeDir,
    now: params.now,
    targetTools: [params.targetTool],
  });

  return {
    imported: true,
    candidate,
    result,
  };
}
