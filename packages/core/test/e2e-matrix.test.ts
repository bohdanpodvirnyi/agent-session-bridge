import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  convertConversationToCodexRollout,
  convertNormalizedToClaudeLine,
  convertNormalizedToPiEntry,
  getClaudeCodeProjectDir,
  getCodexSessionDir,
  getPiSessionDir,
  loadSourceSessionSnapshot,
  readClaudeCodeSession,
  readCodexRollout,
  readPiSession,
  syncSourceSessionToTargets,
  type CodexRolloutItem,
  type CodexRolloutTemplate,
  type NormalizedMessage,
  type ToolName,
} from "../src/index.js";

const fixturesDir = join(import.meta.dirname, "fixtures");
const toolNames = ["pi", "claude", "codex"] as const;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function makeTempWorkspace(): Promise<{
  homeDir: string;
  projectDir: string;
  registryPath: string;
}> {
  const rootDir = await import("node:fs/promises").then((fs) =>
    fs.mkdtemp(join(tmpdir(), "agent-session-bridge-matrix-")),
  );
  const homeDir = join(rootDir, "home");
  const projectDir = join(rootDir, "workspace", "demo-project");
  const registryPath = join(homeDir, ".agent-session-bridge", "registry.json");

  await mkdir(homeDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await mkdir(join(projectDir, ".git"), { recursive: true });

  return { homeDir, projectDir, registryPath };
}

async function writeAdjustedFixture(
  sourcePath: string,
  targetPath: string,
  projectDir: string,
): Promise<void> {
  const content = await readFile(sourcePath, "utf8");
  await mkdir(join(targetPath, ".."), { recursive: true });
  await writeFile(
    targetPath,
    content.replaceAll("/repo/demo", projectDir),
    "utf8",
  );
}

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function buildMessages(
  prefix: string,
  startedAt: Date,
): { user: NormalizedMessage; assistant: NormalizedMessage } {
  const userTimestamp = new Date(startedAt.getTime() + 1_000).toISOString();
  const assistantTimestamp = new Date(
    startedAt.getTime() + 2_000,
  ).toISOString();

  return {
    user: {
      id: `${prefix}-user`,
      role: "user",
      timestamp: userTimestamp,
      content: [{ type: "text", text: `${prefix} user` }],
    },
    assistant: {
      id: `${prefix}-assistant`,
      role: "assistant",
      timestamp: assistantTimestamp,
      content: [{ type: "text", text: `${prefix} assistant` }],
      provider: "openai-codex",
      model: "gpt-5.4",
      usage: zeroUsage(),
    },
  };
}

function snapshotTexts(snapshot: Awaited<ReturnType<typeof loadSourceSessionSnapshot>>) {
  return snapshot.chunks.flatMap((chunk) =>
    chunk.message.content.flatMap((item) => {
      if (item.type === "text") {
        return [item.text];
      }
      if (item.type === "thinking") {
        return [item.thinking];
      }
      if (item.type === "tool_result") {
        return [item.output];
      }
      return [];
    }),
  );
}

function extractCodexTemplate(
  items: CodexRolloutItem[],
  cwd: string,
): CodexRolloutTemplate | undefined {
  const sessionMeta =
    items.find((item) => item.type === "session_meta")?.payload ?? null;
  const taskStarted =
    items.find(
      (item) =>
        item.type === "event_msg" && item.payload.type === "task_started",
    )?.payload ?? null;
  const turnContext =
    items.find((item) => item.type === "turn_context")?.payload ?? null;

  if (!sessionMeta || !taskStarted || !turnContext) {
    return undefined;
  }

  const {
    id: _sessionId,
    cwd: _sessionCwd,
    timestamp: _sessionTimestamp,
    ...sessionMetaTemplate
  } = sessionMeta;
  const { type: _taskType, turn_id: _turnId, ...taskStartedTemplate } =
    taskStarted;
  const {
    turn_id: _turnContextId,
    cwd: _turnCwd,
    current_date: _turnDate,
    ...turnContextTemplate
  } = turnContext;

  return {
    sessionMeta: {
      ...sessionMetaTemplate,
      cwd,
    },
    taskStarted: taskStartedTemplate,
    turnContext: {
      ...turnContextTemplate,
      cwd,
    },
  };
}

async function appendJsonLines(path: string, items: unknown[]): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    `${(await readFile(path, "utf8").catch(() => ""))}${items
      .map((item) => JSON.stringify(item))
      .join("\n")}\n`,
    "utf8",
  );
}

async function appendPiTurn(
  path: string,
  prefix: string,
): Promise<{ sessionId: string; expectedTexts: string[] }> {
  const session = await readPiSession(path);
  const lastTimestamp =
    session.entries.at(-1)?.timestamp ?? session.header.timestamp ?? new Date().toISOString();
  const startedAt = new Date(lastTimestamp);
  const { user, assistant } = buildMessages(prefix, startedAt);
  const lastId = session.entries.at(-1)?.id ?? null;
  const userEntry = convertNormalizedToPiEntry(user, lastId);
  const assistantEntry = convertNormalizedToPiEntry(
    assistant,
    userEntry.id ?? null,
  );

  await appendJsonLines(path, [userEntry, assistantEntry]);

  return {
    sessionId: session.header.id,
    expectedTexts: [`${prefix} user`, `${prefix} assistant`],
  };
}

async function appendClaudeTurn(
  path: string,
  prefix: string,
): Promise<{ sessionId: string; expectedTexts: string[] }> {
  const lines = await readClaudeCodeSession(path);
  const sessionId =
    lines.find((line) => typeof line.sessionId === "string")?.sessionId ??
    randomUUID();
  const cwd =
    lines.find((line) => typeof line.cwd === "string")?.cwd ?? "/repo/demo";
  const lastTimestamp =
    lines
      .map((line) => line.timestamp)
      .filter((value): value is string => Boolean(value))
      .at(-1) ?? new Date().toISOString();
  const startedAt = new Date(lastTimestamp);
  const { user, assistant } = buildMessages(prefix, startedAt);
  const lastUuid =
    lines
      .map((line) => line.uuid)
      .filter((value): value is string => Boolean(value))
      .at(-1) ?? null;

  const userLine = convertNormalizedToClaudeLine(user, sessionId, lastUuid, cwd);
  const assistantLine = convertNormalizedToClaudeLine(
    assistant,
    sessionId,
    userLine.uuid ?? null,
    cwd,
  );
  await appendJsonLines(path, [userLine, assistantLine]);

  return {
    sessionId,
    expectedTexts: [`${prefix} user`, `${prefix} assistant`],
  };
}

async function appendCodexTurn(
  path: string,
  prefix: string,
): Promise<{ sessionId: string; expectedTexts: string[] }> {
  const items = await readCodexRollout(path);
  const sessionMeta = items.find((item) => item.type === "session_meta");
  const sessionId =
    typeof sessionMeta?.payload.id === "string"
      ? sessionMeta.payload.id
      : randomUUID();
  const cwd =
    typeof sessionMeta?.payload.cwd === "string"
      ? sessionMeta.payload.cwd
      : "/repo/demo";
  const lastTimestamp =
    items
      .map((item) => {
        const payloadTimestamp =
          typeof item.payload.timestamp === "string"
            ? item.payload.timestamp
            : undefined;
        return (
          ((item as { timestamp?: unknown }).timestamp as string | undefined) ??
          payloadTimestamp
        );
      })
      .filter((value): value is string => Boolean(value))
      .at(-1) ?? new Date().toISOString();
  const startedAt = new Date(lastTimestamp);
  const { user, assistant } = buildMessages(prefix, startedAt);
  const template = extractCodexTemplate(items, cwd);
  const rollout = convertConversationToCodexRollout(
    [user, assistant],
    cwd,
    sessionId,
    {
      includeSessionMeta: false,
      template,
    },
  );

  let seenAssistant = false;
  const userTimestamp = user.timestamp;
  const assistantTimestamp = assistant.timestamp;
  const withTimestamps = rollout.map((item) => {
    const isAssistantMessage =
      item.type === "response_item" && item.payload.role === "assistant";
    const isAssistantEvent =
      item.type === "event_msg" &&
      (item.payload.type === "agent_message" ||
        item.payload.type === "task_complete");

    if (isAssistantMessage) {
      seenAssistant = true;
    }

    return {
      timestamp:
        seenAssistant || isAssistantEvent ? assistantTimestamp : userTimestamp,
      ...item,
    };
  });

  await appendJsonLines(path, withTimestamps);

  return {
    sessionId,
    expectedTexts: [`${prefix} user`, `${prefix} assistant`],
  };
}

async function appendNativeTurn(
  tool: ToolName,
  path: string,
  prefix: string,
): Promise<{ sessionId: string; expectedTexts: string[] }> {
  if (tool === "pi") {
    return appendPiTurn(path, prefix);
  }
  if (tool === "claude") {
    return appendClaudeTurn(path, prefix);
  }
  return appendCodexTurn(path, prefix);
}

async function assertPiSessionSafe(path: string): Promise<void> {
  const session = await readPiSession(path);
  for (const entry of session.entries) {
    const message =
      typeof entry.message === "object" && entry.message !== null
        ? (entry.message as Record<string, unknown>)
        : null;
    if (message?.role !== "assistant") {
      continue;
    }

    const usage =
      typeof message.usage === "object" && message.usage !== null
        ? (message.usage as Record<string, unknown>)
        : null;
    const cost =
      typeof usage?.cost === "object" && usage.cost !== null
        ? (usage.cost as Record<string, unknown>)
        : null;

    expect(typeof message.provider).toBe("string");
    expect(typeof message.model).toBe("string");
    expect(typeof usage?.input).toBe("number");
    expect(typeof usage?.output).toBe("number");
    expect(typeof usage?.cacheRead).toBe("number");
    expect(typeof usage?.cacheWrite).toBe("number");
    expect(typeof cost?.total).toBe("number");
  }
}

async function assertCodexSessionStable(path: string): Promise<void> {
  const items = await readCodexRollout(path);
  expect(items[0]?.type).toBe("session_meta");
  expect(
    items.some(
      (item) =>
        item.type === "event_msg" && item.payload.type === "task_started",
    ),
  ).toBe(true);
  expect(
    items.some(
      (item) =>
        item.type === "event_msg" && item.payload.type === "task_complete",
    ),
  ).toBe(true);
}

function sourceFixturePath(tool: ToolName): string {
  if (tool === "pi") {
    return join(fixturesDir, "pi-session.jsonl");
  }
  if (tool === "claude") {
    return join(fixturesDir, "claude-session.jsonl");
  }
  return join(fixturesDir, "codex-rollout.jsonl");
}

function targetPathForSource(
  tool: ToolName,
  projectDir: string,
  homeDir: string,
  startedAt: Date,
): string {
  if (tool === "pi") {
    return join(getPiSessionDir(projectDir, homeDir), "seed-pi.jsonl");
  }
  if (tool === "claude") {
    return join(
      getClaudeCodeProjectDir(projectDir, homeDir),
      "seed-claude.jsonl",
    );
  }
  return join(getCodexSessionDir(startedAt, homeDir), "seed-codex.jsonl");
}

function otherTool(source: ToolName, target: ToolName): ToolName {
  return toolNames.find((tool) => tool !== source && tool !== target)!;
}

const matrixCases: Array<{ sourceTool: ToolName; continueTool: ToolName }> = [
  { sourceTool: "pi", continueTool: "claude" },
  { sourceTool: "pi", continueTool: "codex" },
  { sourceTool: "claude", continueTool: "pi" },
  { sourceTool: "claude", continueTool: "codex" },
  { sourceTool: "codex", continueTool: "pi" },
  { sourceTool: "codex", continueTool: "claude" },
];

describe("cross-agent matrix end to end", () => {
  it.each(matrixCases)(
    "converts $sourceTool into $continueTool, continues natively, and syncs onward",
    async ({ sourceTool, continueTool }) => {
      const { homeDir, projectDir, registryPath } = await makeTempWorkspace();
      const startedAt = new Date("2026-04-05T10:00:00.000Z");
      const sourcePath = targetPathForSource(
        sourceTool,
        projectDir,
        homeDir,
        startedAt,
      );

      await writeAdjustedFixture(
        sourceFixturePath(sourceTool),
        sourcePath,
        projectDir,
      );

      const initial = await syncSourceSessionToTargets({
        sourceTool,
        sourcePath,
        registryPath,
        homeDir,
        now: startedAt,
      });

      const continueMirror = initial.conversation.mirrors[continueTool]!;
      const continuePrefix = `${sourceTool}-to-${continueTool}-continued`;
      const continuation = await appendNativeTurn(
        continueTool,
        continueMirror.sessionPath,
        continuePrefix,
      );

      const continuedSnapshot = await loadSourceSessionSnapshot(
        continueTool,
        continueMirror.sessionPath,
        continuation.sessionId,
      );
      const continuedText = snapshotTexts(continuedSnapshot).join("\n");
      for (const expectedText of continuation.expectedTexts) {
        expect(continuedText).toContain(expectedText);
      }

      const onward = await syncSourceSessionToTargets({
        sourceTool: continueTool,
        sourcePath: continueMirror.sessionPath,
        sourceSessionId: continuation.sessionId,
        registryPath,
        homeDir,
        now: new Date("2026-04-05T10:05:00.000Z"),
        targetTools: [sourceTool, otherTool(sourceTool, continueTool)],
      });

      const destinations = [sourceTool, otherTool(sourceTool, continueTool)];
      for (const destination of destinations) {
        const mirror = onward.conversation.mirrors[destination]!;
        const destinationSnapshot = await loadSourceSessionSnapshot(
          destination,
          mirror.sessionPath,
          mirror.nativeId,
        );
        const destinationText = snapshotTexts(destinationSnapshot).join("\n");
        for (const expectedText of continuation.expectedTexts) {
          expect(destinationText).toContain(expectedText);
        }

        if (destination === "pi" && destination !== sourceTool) {
          await assertPiSessionSafe(mirror.sessionPath);
        }

        if (destination === "codex") {
          await assertCodexSessionStable(mirror.sessionPath);
        }
      }

      for (const initialTarget of toolNames.filter(
        (tool) => tool !== sourceTool,
      )) {
        const mirror = initial.conversation.mirrors[initialTarget];
        expect(mirror).toBeDefined();
        const mirrorSnapshot = await loadSourceSessionSnapshot(
          initialTarget,
          mirror!.sessionPath,
          mirror!.nativeId,
        );
        expect(mirrorSnapshot.chunks.length).toBeGreaterThan(0);
      }
    },
  );
});
