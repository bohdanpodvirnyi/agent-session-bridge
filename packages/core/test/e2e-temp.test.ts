import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  chooseResumeCandidate,
  convertPiEntryToNormalized,
  deriveProjectKey,
  emptyRegistry,
  findConversationByBridgeSessionId,
  findGitRepoRoot,
  getClaudeCodeProjectDir,
  getCodexSessionDir,
  getPiSessionDir,
  loadRegistry,
  oneShotBackfill,
  readClaudeCodeSession,
  readCodexRollout,
  readPiSession,
  saveRegistry,
  setRepairState,
  startWatchMode,
  syncClaudeSessionToPi,
  syncPiSessionToClaude,
  upsertConversation,
  type BridgeRegistry,
  type ClaudeCodeLine,
  type CodexRolloutItem,
  type NormalizedMessage,
} from "../src/index.js";
import { runCli } from "../../cli/src/index.js";
import {
  handleSessionStart as handleClaudeSessionStart,
  handleStop as handleClaudeStop,
  parseClaudeHookPayload,
} from "../../claude-code/src/index.js";
import {
  buildExperimentalRollout,
  parseCodexHookPayload,
  registerCodexMirror,
} from "../../codex/src/index.js";
import {
  handleSessionStart as handlePiSessionStart,
  restorePiBridgeState,
  serializePiBridgeState,
} from "../../pi/src/index.js";
import { runOneShotBackfill } from "../../daemon/src/index.js";

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
  registryPath: string;
}> {
  const rootDir = await import("node:fs/promises").then((fs) =>
    fs.mkdtemp(join(tmpdir(), "agent-session-bridge-e2e-")),
  );
  const homeDir = join(rootDir, "home");
  const projectDir = join(rootDir, "workspace", "demo-project");
  const registryPath = join(homeDir, ".agent-session-bridge", "registry.json");

  await mkdir(homeDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await mkdir(join(projectDir, ".git"), { recursive: true });

  return { rootDir, homeDir, projectDir, registryPath };
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

async function makeCliDeps(
  registryPath: string,
  homeDir: string,
  cwd: string,
  output: string[],
): Promise<{
  load(): Promise<BridgeRegistry>;
  save(registry: BridgeRegistry): Promise<void>;
  stdout(line: string): void;
  homeDir: string;
  cwd: string;
  readFile: typeof readFile;
  writeFile: typeof writeFile;
  mkdir: typeof mkdir;
}> {
  return {
    homeDir,
    cwd,
    readFile,
    writeFile,
    mkdir,
    load: () =>
      loadRegistry(registryPath, {
        readFile,
      }),
    save: (registry) =>
      saveRegistry(registryPath, registry, {
        mkdir: async (path, options) => {
          await mkdir(path, options);
        },
        writeFile,
        rename: async (from, to) => {
          const content = await readFile(from, "utf8");
          await writeFile(to, content, "utf8");
        },
      }),
    stdout(line) {
      output.push(line);
    },
  };
}

async function writeJsonl(path: string, lines: unknown[]): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8",
  );
}

describe("temp-folder end to end", () => {
  it("bridges Pi, Claude, and Codex flows in an isolated fake home and project", async () => {
    const { homeDir, projectDir, registryPath } = await makeTempWorkspace();
    const { canonicalCwd, projectKey } = await deriveProjectKey(projectDir, {
      realpath: async (path) => path,
      findRepoRoot: async (cwd) =>
        findGitRepoRoot(cwd, {
          exists,
        }),
    });

    expect(projectKey).toBe(projectDir);
    expect(canonicalCwd).toBe(projectDir);

    const piDir = getPiSessionDir(projectDir, homeDir);
    const claudeDir = getClaudeCodeProjectDir(projectDir, homeDir);
    const codexDir = getCodexSessionDir(
      new Date("2026-04-05T10:00:00.000Z"),
      homeDir,
    );

    await mkdir(piDir, { recursive: true });
    await mkdir(claudeDir, { recursive: true });
    await mkdir(codexDir, { recursive: true });

    const piSessionPath = join(piDir, "2026-04-05T10-00-00_pi.jsonl");
    await writeAdjustedFixture(
      join(fixturesDir, "pi-session.jsonl"),
      piSessionPath,
      projectDir,
    );

    const piSession = await readPiSession(piSessionPath);
    const bridgeConversation = handlePiSessionStart({
      bridgeConversation: {
        bridgeSessionId: "bridge-e2e-1",
        projectKey,
        canonicalCwd,
        createdAt: "2026-04-05T10:00:00.000Z",
        updatedAt: "2026-04-05T10:00:00.000Z",
        status: "active",
        mirrors: {
          pi: {
            nativeId: piSession.header.id,
            sessionPath: piSessionPath,
          },
        },
        lastWrittenOffsets: [],
      },
      mirrorSessionId: "claude-e2e-1",
      mirrorPath: join(claudeDir, "claude-e2e-1.jsonl"),
      timestamp: "2026-04-05T10:01:00.000Z",
    });

    const serializedState = serializePiBridgeState({
      mirrorSessionId: "claude-e2e-1",
      mirrorPath: join(claudeDir, "claude-e2e-1.jsonl"),
      updatedAt: "2026-04-05T10:01:00.000Z",
    });
    expect(restorePiBridgeState(serializedState).mirrorSessionId).toBe(
      "claude-e2e-1",
    );

    const claudeLines = syncPiSessionToClaude(piSession, "claude-e2e-1");
    await writeJsonl(
      bridgeConversation.mirrors.claude!.sessionPath,
      claudeLines,
    );

    const parsedClaudeSession = await readClaudeCodeSession(
      bridgeConversation.mirrors.claude!.sessionPath,
    );
    expect(parsedClaudeSession).toHaveLength(3);

    const piMirrorEntries = syncClaudeSessionToPi(parsedClaudeSession);
    expect(piMirrorEntries).toHaveLength(3);
    expect(piMirrorEntries[0]?.message).toMatchObject({ role: "user" });

    const normalizedMessages: NormalizedMessage[] = piSession.entries.flatMap(
      (entry) => {
        const normalized = convertPiEntryToNormalized(entry);
        return normalized ? [normalized] : [];
      },
    );
    const codexRollout = buildExperimentalRollout(
      normalizedMessages,
      projectDir,
      "codex-e2e-1",
    );
    const codexRolloutPath = join(codexDir, "rollout-codex-e2e-1.jsonl");
    await writeJsonl(codexRolloutPath, codexRollout);

    const parsedCodexRollout = await readCodexRollout(codexRolloutPath);
    expect(parsedCodexRollout[0]?.type).toBe("session_meta");
    expect(parsedCodexRollout.some((item) => item.type === "event_msg")).toBe(
      true,
    );

    const withCodexMirror = registerCodexMirror(
      bridgeConversation,
      "codex-e2e-1",
      codexRolloutPath,
      "2026-04-05T10:02:00.000Z",
    );
    const savedRegistry = upsertConversation(emptyRegistry(), withCodexMirror);
    await saveRegistry(registryPath, savedRegistry, {
      mkdir: async (path, options) => {
        await mkdir(path, options);
      },
      writeFile,
      rename: async (from, to) => {
        const content = await readFile(from, "utf8");
        await writeFile(to, content, "utf8");
      },
    });

    const loadedRegistry = await loadRegistry(registryPath, { readFile });
    expect(
      findConversationByBridgeSessionId(loadedRegistry, "bridge-e2e-1")?.mirrors
        .codex?.nativeId,
    ).toBe("codex-e2e-1");

    const selectedOnSessionStart = handleClaudeSessionStart(
      [
        {
          id: "pi-native",
          path: piSessionPath,
          sourceTool: "pi",
          updatedAt: "2026-04-05T10:00:00.000Z",
        },
        {
          id: "claude-e2e-1",
          path: bridgeConversation.mirrors.claude!.sessionPath,
          sourceTool: "claude",
          updatedAt: "2026-04-05T10:01:00.000Z",
        },
      ],
      withCodexMirror,
    );
    expect(selectedOnSessionStart?.id).toBe("claude-e2e-1");

    expect(
      parseClaudeHookPayload(
        JSON.stringify({
          session_id: "claude-e2e-1",
          transcript_path: bridgeConversation.mirrors.claude!.sessionPath,
          cwd: projectDir,
        }),
      ),
    ).toMatchObject({ session_id: "claude-e2e-1", cwd: projectDir });

    expect(
      parseCodexHookPayload(
        JSON.stringify({
          session_id: "codex-e2e-1",
          cwd: projectDir,
        }),
      ),
    ).toMatchObject({ session_id: "codex-e2e-1", cwd: projectDir });

    const claudeStopResult = handleClaudeStop(
      parsedClaudeSession as ClaudeCodeLine[],
      withCodexMirror,
    );
    expect(claudeStopResult.linesProcessed).toBe(parsedClaudeSession.length);
    expect(claudeStopResult.conversation.status).toBe("active");
  });

  it("runs CLI and daemon flows against a temp registry and verifies persisted behavior", async () => {
    const { homeDir, projectDir, registryPath } = await makeTempWorkspace();
    const output: string[] = [];
    const cliDeps = await makeCliDeps(
      registryPath,
      homeDir,
      projectDir,
      output,
    );
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

    await runCli(["setup"], cliDeps);
    await runCli(["link", "bridge-cli-1", projectDir], cliDeps);
    await runCli(["list"], cliDeps);
    await runCli(
      ["import", "--latest", "--tool", "claude", "--cwd", projectDir],
      cliDeps,
    );
    await runCli(
      ["import", "--all", "--tool", "claude", "--cwd", projectDir],
      cliDeps,
    );
    await runCli(["audit"], cliDeps);
    await runCli(["repair", "bridge-cli-1"], cliDeps);
    await runCli(["import-project", projectDir], cliDeps);

    expect(output.some((line) => line.includes("setup complete"))).toBe(true);
    expect(output.some((line) => line.includes("linked bridge-cli-1"))).toBe(
      true,
    );
    expect(output.some((line) => line.includes("import claude:"))).toBe(true);
    expect(output.some((line) => line.includes("imported"))).toBe(true);
    expect(output.some((line) => line.includes("repair queued"))).toBe(true);
    expect(output.some((line) => line.includes("bridge-cli-1"))).toBe(true);

    const registry = await loadRegistry(registryPath, { readFile });
    const conversation = findConversationByBridgeSessionId(
      registry,
      "bridge-cli-1",
    );
    expect(conversation?.repair?.status).toBe("running");

    const watcherTicks: string[] = [];
    const watcher = startWatchMode(() => {
      watcherTicks.push("tick");
    });
    watcher.stop();
    expect(watcherTicks).toEqual(["tick"]);

    const daemonResult = runOneShotBackfill(
      [
        {
          id: "older",
          path: join(homeDir, "old.jsonl"),
          sourceTool: "pi",
          updatedAt: "2026-04-05T09:00:00.000Z",
        },
        {
          id: "newer",
          path: join(homeDir, "new.jsonl"),
          sourceTool: "claude",
          updatedAt: "2026-04-05T11:00:00.000Z",
        },
      ],
      conversation,
    );
    expect(daemonResult.reusedRegistryLogic).toBe(true);

    const explicitCandidate = chooseResumeCandidate(
      [
        {
          id: "bridge-cli-1",
          path: join(homeDir, "linked.jsonl"),
          sourceTool: "claude",
          updatedAt: "2026-04-05T08:00:00.000Z",
        },
        {
          id: "newer",
          path: join(homeDir, "new.jsonl"),
          sourceTool: "claude",
          updatedAt: "2026-04-05T11:00:00.000Z",
        },
      ],
      {
        ...conversation!,
        mirrors: {
          ...conversation!.mirrors,
          claude: {
            nativeId: "bridge-cli-1",
            sessionPath: join(homeDir, "linked.jsonl"),
          },
        },
      },
    );
    expect(explicitCandidate?.id).toBe("bridge-cli-1");
  });
});
