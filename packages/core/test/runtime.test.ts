import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import {
  getClaudeCodeProjectDir,
  importLatestSessionToTarget,
  isCodexThreadId,
  listForeignSessionCandidates,
  loadSourceSessionSnapshot,
  loadRegistry,
  readClaudeCodeSession,
  readCodexRollout,
  readPiSession,
  syncSourceSessionToTargets,
} from "../src/index.js";

const fixturesDir = join(import.meta.dirname, "fixtures");

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function makeTempWorkspace(): Promise<{
  rootDir: string;
  homeDir: string;
  projectDir: string;
  nestedDir: string;
  registryPath: string;
}> {
  const rootDir = await import("node:fs/promises").then((fs) =>
    fs.mkdtemp(join(tmpdir(), "agent-session-bridge-runtime-")),
  );
  const homeDir = join(rootDir, "home");
  const projectDir = join(rootDir, "workspace", "demo-project");
  const nestedDir = join(projectDir, "packages", "app");
  const registryPath = join(homeDir, ".agent-session-bridge", "registry.json");

  await mkdir(homeDir, { recursive: true });
  await mkdir(nestedDir, { recursive: true });
  await mkdir(join(projectDir, ".git"), { recursive: true });

  return { rootDir, homeDir, projectDir, nestedDir, registryPath };
}

async function writeAdjustedFixture(
  sourcePath: string,
  targetPath: string,
  cwd: string,
): Promise<void> {
  const content = await readFile(sourcePath, "utf8");
  await mkdir(join(targetPath, ".."), { recursive: true });
  await writeFile(targetPath, content.replaceAll("/repo/demo", cwd), "utf8");
}

describe("runtime sync flows", () => {
  it("syncs a Pi session into Claude and Codex mirrors without duplicating on rerun", async () => {
    const { homeDir, projectDir, registryPath } = await makeTempWorkspace();
    const piSessionPath = join(
      homeDir,
      ".pi",
      "agent",
      "sessions",
      "--demo-project-source--",
      "pi-session.jsonl",
    );

    await writeAdjustedFixture(
      join(fixturesDir, "pi-session.jsonl"),
      piSessionPath,
      projectDir,
    );

    const firstRun = await syncSourceSessionToTargets({
      sourceTool: "pi",
      sourcePath: piSessionPath,
      registryPath,
      homeDir,
      now: new Date("2026-04-05T10:05:00.000Z"),
    });

    expect(firstRun.writes).toHaveLength(2);
    expect(
      firstRun.writes.find((write) => write.targetTool === "claude")
        ?.appendedCount,
    ).toBe(3);
    expect(
      firstRun.writes.find((write) => write.targetTool === "codex")
        ?.appendedCount,
    ).toBeGreaterThan(3);

    const claudeMirrorPath = firstRun.conversation.mirrors.claude?.sessionPath;
    const codexMirrorPath = firstRun.conversation.mirrors.codex?.sessionPath;

    expect(claudeMirrorPath).toBeTruthy();
    expect(codexMirrorPath).toBeTruthy();
    expect(isCodexThreadId(firstRun.conversation.mirrors.codex!.nativeId)).toBe(
      true,
    );
    expect(await exists(claudeMirrorPath!)).toBe(true);
    expect(await exists(codexMirrorPath!)).toBe(true);

    const claudeMirror = await readClaudeCodeSession(claudeMirrorPath!);
    const codexMirror = await readCodexRollout(codexMirrorPath!);
    expect(claudeMirror).toHaveLength(3);
    expect(codexMirror[0]?.type).toBe("session_meta");

    const secondRun = await syncSourceSessionToTargets({
      sourceTool: "pi",
      sourcePath: piSessionPath,
      registryPath,
      homeDir,
      now: new Date("2026-04-05T10:06:00.000Z"),
    });

    expect(secondRun.writes.every((write) => write.appendedCount === 0)).toBe(
      true,
    );
    expect(await readClaudeCodeSession(claudeMirrorPath!)).toHaveLength(
      claudeMirror.length,
    );
    expect(await readCodexRollout(codexMirrorPath!)).toHaveLength(
      codexMirror.length,
    );

    const registry = await loadRegistry(registryPath, { readFile });
    expect(registry.conversations).toHaveLength(1);
    expect(registry.conversations[0]?.mirrors.pi?.sessionPath).toBe(
      piSessionPath,
    );
  });

  it("waits briefly for a newly-created source session file before reading it", async () => {
    const { homeDir, projectDir } = await makeTempWorkspace();
    const piSessionPath = join(
      homeDir,
      ".pi",
      "agent",
      "sessions",
      "--demo-project-source--",
      "pi-delayed-session.jsonl",
    );

    const snapshotPromise = loadSourceSessionSnapshot("pi", piSessionPath);

    await delay(80);
    await writeAdjustedFixture(
      join(fixturesDir, "pi-session.jsonl"),
      piSessionPath,
      projectDir,
    );

    const snapshot = await snapshotPromise;
    expect(snapshot.sourceTool).toBe("pi");
    expect(snapshot.sourcePath).toBe(piSessionPath);
    expect(snapshot.chunks).toHaveLength(3);
  });

  it("discovers nested foreign sessions and imports the latest one into Pi", async () => {
    const { homeDir, nestedDir, projectDir, registryPath } =
      await makeTempWorkspace();
    const claudeDir = getClaudeCodeProjectDir(nestedDir, homeDir);
    const olderClaudePath = join(claudeDir, "claude-older.jsonl");
    const latestClaudePath = join(claudeDir, "claude-latest.jsonl");

    await writeAdjustedFixture(
      join(fixturesDir, "claude-session.jsonl"),
      olderClaudePath,
      nestedDir,
    );
    await writeAdjustedFixture(
      join(fixturesDir, "claude-session.jsonl"),
      latestClaudePath,
      nestedDir,
    );

    const latestContent = await readFile(latestClaudePath, "utf8");
    await writeFile(
      latestClaudePath,
      latestContent.replaceAll(
        "2026-04-05T10:00:03.000Z",
        "2026-04-05T11:00:03.000Z",
      ),
      "utf8",
    );

    const candidates = await listForeignSessionCandidates(
      projectDir,
      homeDir,
      "pi",
    );
    expect(candidates.map((candidate) => candidate.path)).toContain(
      latestClaudePath,
    );

    const imported = await importLatestSessionToTarget({
      targetTool: "pi",
      cwd: projectDir,
      homeDir,
      registryPath,
      now: new Date("2026-04-05T11:05:00.000Z"),
    });

    expect(imported.imported).toBe(true);
    expect(imported.candidate?.sourceTool).toBe("claude");

    const piMirrorPath = imported.result?.conversation.mirrors.pi?.sessionPath;
    expect(piMirrorPath).toBeTruthy();
    expect(await exists(piMirrorPath!)).toBe(true);

    const piMirror = await readPiSession(piMirrorPath!);
    expect(piMirror.header.cwd).toBe(nestedDir);
    expect(piMirror.entries).toHaveLength(3);
  });

  it("rotates invalid Codex mirror ids to resumable thread ids", async () => {
    const { homeDir, projectDir, registryPath } = await makeTempWorkspace();
    const piSessionPath = join(
      homeDir,
      ".pi",
      "agent",
      "sessions",
      "--demo-project-source--",
      "pi-session.jsonl",
    );

    await writeAdjustedFixture(
      join(fixturesDir, "pi-session.jsonl"),
      piSessionPath,
      projectDir,
    );

    const firstRun = await syncSourceSessionToTargets({
      sourceTool: "pi",
      sourcePath: piSessionPath,
      registryPath,
      homeDir,
      now: new Date("2026-04-05T10:05:00.000Z"),
    });

    const invalidMirrorId = "ec026cae-622d-47bc-b9b1-2b2af1fb9b12";
    const invalidMirrorPath = join(
      homeDir,
      ".codex",
      "sessions",
      "2026",
      "04",
      "05",
      `rollout-2026-04-05T10-05-00-000Z-${invalidMirrorId}.jsonl`,
    );

    const registry = await loadRegistry(registryPath, { readFile });
    registry.conversations[0] = {
      ...registry.conversations[0]!,
      mirrors: {
        ...registry.conversations[0]!.mirrors,
        codex: {
          nativeId: invalidMirrorId,
          sessionPath: invalidMirrorPath,
        },
      },
    };
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

    const repairedRun = await syncSourceSessionToTargets({
      sourceTool: "pi",
      sourcePath: piSessionPath,
      registryPath,
      homeDir,
      now: new Date("2026-04-05T10:06:00.000Z"),
    });

    expect(repairedRun.conversation.mirrors.codex?.nativeId).not.toBe(
      invalidMirrorId,
    );
    expect(
      isCodexThreadId(repairedRun.conversation.mirrors.codex!.nativeId),
    ).toBe(true);
  });

  it("skips replaying the imported Codex prefix back into Pi and Claude", async () => {
    const { homeDir, projectDir, registryPath } = await makeTempWorkspace();
    const piSessionPath = join(
      homeDir,
      ".pi",
      "agent",
      "sessions",
      "--demo-project-source--",
      "pi-session.jsonl",
    );

    await writeAdjustedFixture(
      join(fixturesDir, "pi-session.jsonl"),
      piSessionPath,
      projectDir,
    );

    const firstRun = await syncSourceSessionToTargets({
      sourceTool: "pi",
      sourcePath: piSessionPath,
      registryPath,
      homeDir,
      now: new Date("2026-04-05T10:05:00.000Z"),
    });

    const codexMirrorPath = firstRun.conversation.mirrors.codex?.sessionPath;
    expect(codexMirrorPath).toBeTruthy();
    expect(firstRun.conversation.mirrors.codex?.seededSourceOffset).toBeTruthy();

    const codexReplay = await syncSourceSessionToTargets({
      sourceTool: "codex",
      sourcePath: codexMirrorPath!,
      sourceSessionId: firstRun.conversation.mirrors.codex?.nativeId,
      registryPath,
      homeDir,
      now: new Date("2026-04-05T10:06:00.000Z"),
      targetTools: ["pi", "claude"],
    });

    expect(codexReplay.writes.every((write) => write.appendedCount === 0)).toBe(
      true,
    );
  });

  it("keeps separate Codex sessions in the same project as separate Pi conversations", async () => {
    const { homeDir, projectDir, registryPath } = await makeTempWorkspace();
    const codexDir = join(homeDir, ".codex", "sessions", "2026", "04", "05");
    const firstCodexPath = join(codexDir, "rollout-a.jsonl");
    const secondCodexPath = join(codexDir, "rollout-b.jsonl");

    await writeAdjustedFixture(
      join(fixturesDir, "codex-rollout.jsonl"),
      firstCodexPath,
      projectDir,
    );

    const firstContent = await readFile(firstCodexPath, "utf8");
    await writeFile(
      secondCodexPath,
      firstContent
        .replaceAll("codex-session-1", "codex-session-2")
        .replaceAll("codex-user-1", "codex-user-2")
        .replaceAll("codex-assistant-1", "codex-assistant-2")
        .replaceAll("2026-04-05T10:00:01.000Z", "2026-04-05T11:00:01.000Z")
        .replaceAll("2026-04-05T10:00:02.000Z", "2026-04-05T11:00:02.000Z")
        .replaceAll("2026-04-05T10:00:03.000Z", "2026-04-05T11:00:03.000Z")
        .replaceAll("Fix auth", "Second auth issue")
        .replaceAll("Looking.", "Checking second thread."),
      "utf8",
    );

    const firstRun = await syncSourceSessionToTargets({
      sourceTool: "codex",
      sourcePath: firstCodexPath,
      registryPath,
      homeDir,
      now: new Date("2026-04-05T10:05:00.000Z"),
      targetTools: ["pi"],
    });

    const secondRun = await syncSourceSessionToTargets({
      sourceTool: "codex",
      sourcePath: secondCodexPath,
      registryPath,
      homeDir,
      now: new Date("2026-04-05T11:05:00.000Z"),
      targetTools: ["pi"],
    });

    expect(firstRun.conversation.bridgeSessionId).not.toBe(
      secondRun.conversation.bridgeSessionId,
    );
    expect(firstRun.conversation.mirrors.pi?.sessionPath).not.toBe(
      secondRun.conversation.mirrors.pi?.sessionPath,
    );

    const registry = await loadRegistry(registryPath, { readFile });
    expect(registry.conversations).toHaveLength(2);

    const firstPi = await readPiSession(firstRun.conversation.mirrors.pi!.sessionPath);
    const secondPi = await readPiSession(
      secondRun.conversation.mirrors.pi!.sessionPath,
    );

    expect(
      firstPi.entries.some(
        (entry) =>
          entry.message?.role === "assistant" &&
          Array.isArray(entry.message.content) &&
          entry.message.content.some(
            (item) =>
              typeof item === "object" &&
              item !== null &&
              (item as { type?: string }).type === "text" &&
              (item as { text?: string }).text === "Looking.",
          ),
      ),
    ).toBe(true);
    expect(
      secondPi.entries.some(
        (entry) =>
          entry.message?.role === "assistant" &&
          Array.isArray(entry.message.content) &&
          entry.message.content.some(
            (item) =>
              typeof item === "object" &&
              item !== null &&
              (item as { type?: string }).type === "text" &&
              (item as { text?: string }).text === "Checking second thread.",
          ),
      ),
    ).toBe(true);
  });

  it("anchors later Pi imports to the current Claude transcript head", async () => {
    const { homeDir, projectDir, registryPath } = await makeTempWorkspace();
    const piSessionPath = join(
      homeDir,
      ".pi",
      "agent",
      "sessions",
      "--demo-project-source--",
      "pi-session.jsonl",
    );

    await writeAdjustedFixture(
      join(fixturesDir, "pi-session.jsonl"),
      piSessionPath,
      projectDir,
    );

    const firstRun = await syncSourceSessionToTargets({
      sourceTool: "pi",
      sourcePath: piSessionPath,
      registryPath,
      homeDir,
      now: new Date("2026-04-05T10:05:00.000Z"),
      targetTools: ["claude"],
    });

    const claudeMirrorPath = firstRun.conversation.mirrors.claude?.sessionPath;
    expect(claudeMirrorPath).toBeTruthy();

    const claudeMirror = await readClaudeCodeSession(claudeMirrorPath!);
    const importedAssistant = claudeMirror.findLast(
      (line) =>
        line.type === "assistant" &&
        Array.isArray(line.message?.content) &&
        line.message.content.some(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            (item as { type?: string }).type === "text" &&
            (item as { text?: string }).text === "Looking.",
        ),
    );
    expect(importedAssistant?.uuid).toBeTruthy();

    const nativeUserUuid = "native-claude-user-1";
    const nativeAssistantUuid = "native-claude-assistant-1";
    await writeFile(
      claudeMirrorPath!,
      `${JSON.stringify({
        type: "user",
        uuid: nativeUserUuid,
        parentUuid: importedAssistant?.uuid ?? null,
        sessionId: firstRun.conversation.mirrors.claude?.nativeId,
        timestamp: "2026-04-05T10:05:30.000Z",
        cwd: projectDir,
        message: {
          role: "user",
          content: "<command-name>/exit</command-name>",
        },
      })}\n${JSON.stringify({
        type: "assistant",
        uuid: nativeAssistantUuid,
        parentUuid: nativeUserUuid,
        sessionId: firstRun.conversation.mirrors.claude?.nativeId,
        timestamp: "2026-04-05T10:05:31.000Z",
        cwd: projectDir,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Catch you later!" }],
          model: "claude-sonnet",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      })}\n`,
      { flag: "a" },
    );

    await writeFile(
      piSessionPath,
      `${JSON.stringify({
        type: "message",
        id: "dddd4444",
        parentId: "cccc3333",
        timestamp: "2026-04-05T10:06:00.000Z",
        message: {
          role: "user",
          content: "Second ping",
        },
      })}\n${JSON.stringify({
        type: "message",
        id: "eeee5555",
        parentId: "dddd4444",
        timestamp: "2026-04-05T10:06:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Second answer." }],
        },
      })}\n`,
      { flag: "a" },
    );

    await syncSourceSessionToTargets({
      sourceTool: "pi",
      sourcePath: piSessionPath,
      registryPath,
      homeDir,
      now: new Date("2026-04-05T10:06:30.000Z"),
      targetTools: ["claude"],
    });

    const updatedClaudeMirror = await readClaudeCodeSession(claudeMirrorPath!);
    const secondPing = updatedClaudeMirror.find(
      (line) =>
        line.type === "user" &&
        Array.isArray(line.message?.content) &&
        line.message.content.some(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            (item as { type?: string }).type === "text" &&
            (item as { text?: string }).text === "Second ping",
        ),
    );
    const secondAnswer = updatedClaudeMirror.find(
      (line) =>
        line.type === "assistant" &&
        Array.isArray(line.message?.content) &&
        line.message.content.some(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            (item as { type?: string }).type === "text" &&
            (item as { text?: string }).text === "Second answer.",
        ),
    );

    expect(secondPing?.parentUuid).toBe(nativeAssistantUuid);
    expect(secondAnswer?.parentUuid).toBe(secondPing?.uuid);
  });

  it("does not replay imported foreign turns when Pi becomes the source again", async () => {
    const { homeDir, projectDir, registryPath } = await makeTempWorkspace();
    const piSessionPath = join(
      homeDir,
      ".pi",
      "agent",
      "sessions",
      "--demo-project-source--",
      "pi-session.jsonl",
    );
    const codexPath = join(
      homeDir,
      ".codex",
      "sessions",
      "2026",
      "04",
      "05",
      "codex-session.jsonl",
    );

    await writeAdjustedFixture(
      join(fixturesDir, "pi-session.jsonl"),
      piSessionPath,
      projectDir,
    );

    const initialPi = await syncSourceSessionToTargets({
      sourceTool: "pi",
      sourcePath: piSessionPath,
      registryPath,
      homeDir,
      now: new Date("2026-04-05T10:05:00.000Z"),
      targetTools: ["claude", "codex"],
    });

    const claudeMirrorPath = initialPi.conversation.mirrors.claude!.sessionPath;

    await syncSourceSessionToTargets({
      sourceTool: "claude",
      sourcePath: claudeMirrorPath,
      sourceSessionId: initialPi.conversation.mirrors.claude!.nativeId,
      registryPath,
      homeDir,
      now: new Date("2026-04-05T10:06:00.000Z"),
      targetTools: ["pi"],
    });

    await writeAdjustedFixture(
      join(fixturesDir, "codex-rollout.jsonl"),
      codexPath,
      projectDir,
    );

    await syncSourceSessionToTargets({
      sourceTool: "codex",
      sourcePath: codexPath,
      registryPath,
      homeDir,
      now: new Date("2026-04-05T10:07:00.000Z"),
      targetTools: ["pi"],
    });

    await writeFile(
      piSessionPath,
      `${JSON.stringify({
        type: "message",
        id: "ffff6666",
        parentId: "cccc3333",
        timestamp: "2026-04-05T10:08:00.000Z",
        message: {
          role: "user",
          content: "Native Pi follow-up",
        },
      })}\n${JSON.stringify({
        type: "message",
        id: "1111aaaa",
        parentId: "ffff6666",
        timestamp: "2026-04-05T10:08:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Native Pi answer." }],
        },
      })}\n`,
      { flag: "a" },
    );

    const replayedPi = await syncSourceSessionToTargets({
      sourceTool: "pi",
      sourcePath: piSessionPath,
      registryPath,
      homeDir,
      now: new Date("2026-04-05T10:09:00.000Z"),
      targetTools: ["claude"],
    });

    const claudeLines = await readClaudeCodeSession(claudeMirrorPath);
    const nativePiPrompts = claudeLines.filter(
      (line) =>
        line.type === "user" &&
        Array.isArray(line.message?.content) &&
        line.message.content.some(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            (item as { type?: string }).type === "text" &&
            (item as { text?: string }).text === "Native Pi follow-up",
        ),
    );
    const repeatedClaudePrompts = claudeLines.filter(
      (line) =>
        line.type === "user" &&
        Array.isArray(line.message?.content) &&
        line.message.content.some(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            (item as { type?: string }).type === "text" &&
            (item as { text?: string }).text === "Fix auth",
        ),
    );

    expect(replayedPi.writes[0]?.appendedCount).toBe(2);
    expect(nativePiPrompts).toHaveLength(1);
    expect(repeatedClaudePrompts).toHaveLength(1);
  });

  it("indexes Codex mirrors against an older threads schema without model columns", async () => {
    const { homeDir, projectDir, registryPath } = await makeTempWorkspace();
    const piSessionPath = join(
      homeDir,
      ".pi",
      "agent",
      "sessions",
      "--demo-project-source--",
      "pi-session.jsonl",
    );
    const codexDir = join(homeDir, ".codex");
    const stateDbPath = join(codexDir, "state_5.sqlite");

    await mkdir(codexDir, { recursive: true });
    execFileSync("sqlite3", [
      stateDbPath,
      `
CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    rollout_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    model_provider TEXT NOT NULL,
    cwd TEXT NOT NULL,
    title TEXT NOT NULL,
    sandbox_policy TEXT NOT NULL,
    approval_mode TEXT NOT NULL,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    has_user_event INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    archived_at INTEGER,
    git_sha TEXT,
    git_branch TEXT,
    git_origin_url TEXT,
    cli_version TEXT NOT NULL DEFAULT '',
    first_user_message TEXT NOT NULL DEFAULT '',
    agent_nickname TEXT,
    agent_role TEXT,
    memory_mode TEXT NOT NULL DEFAULT 'enabled'
);
      `,
    ]);

    await writeAdjustedFixture(
      join(fixturesDir, "pi-session.jsonl"),
      piSessionPath,
      projectDir,
    );

    const result = await syncSourceSessionToTargets({
      sourceTool: "pi",
      sourcePath: piSessionPath,
      registryPath,
      homeDir,
      now: new Date("2026-04-05T10:05:00.000Z"),
    });

    const codexId = result.conversation.mirrors.codex?.nativeId;
    expect(codexId).toBeTruthy();

    const indexedRow = execFileSync("sqlite3", [
      stateDbPath,
      `select id || '|' || cwd || '|' || title || '|' || source from threads where id='${codexId}';`,
    ])
      .toString()
      .trim();

    expect(indexedRow).toContain(codexId!);
    expect(indexedRow).toContain(projectDir);
    expect(indexedRow).toContain("Fix auth");
    expect(indexedRow).toContain("vscode");
  });
});
