import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  createDefaultConfig,
  readClaudeCodeSession,
  serializeBridgeConfig,
} from "agent-session-bridge-core";

import {
  handleSessionStart,
  handleStop,
  parseClaudeHookPayload,
  runClaudeSessionStart,
  runClaudeStop,
} from "../src/index.js";

const fixturesDir = join(
  import.meta.dirname,
  "..",
  "..",
  "core",
  "test",
  "fixtures",
);

async function makeTempWorkspace(): Promise<{
  homeDir: string;
  projectDir: string;
  registryPath: string;
}> {
  const rootDir = await import("node:fs/promises").then((fs) =>
    fs.mkdtemp(join(tmpdir(), "agent-session-bridge-claude-")),
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

async function writeEnabledConfig(
  homeDir: string,
  projectDir: string,
): Promise<void> {
  const config = createDefaultConfig();
  config.optIn = true;
  config.enabledProjects = [projectDir];
  config.directions["claude->pi"] = true;
  config.directions["claude->codex"] = true;

  const configPath = join(homeDir, ".agent-session-bridge", "config.json");
  await mkdir(join(configPath, ".."), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify(serializeBridgeConfig(config), null, 2)}\n`,
    "utf8",
  );
}

describe("claude hooks", () => {
  it("chooses the latest session on first open", () => {
    const selected = handleSessionStart([
      {
        id: "old",
        path: "/tmp/old",
        sourceTool: "pi",
        updatedAt: "2026-04-05T10:00:00.000Z",
      },
      {
        id: "new",
        path: "/tmp/new",
        sourceTool: "pi",
        updatedAt: "2026-04-05T11:00:00.000Z",
      },
    ]);

    expect(selected?.id).toBe("new");
  });

  it("flags conflicting transcripts without blocking processing", () => {
    const result = handleStop(
      [
        {
          type: "assistant",
          uuid: "dup",
          message: { role: "assistant", content: "hi" },
        },
        {
          type: "assistant",
          uuid: "dup",
          message: { role: "assistant", content: "hi again" },
        },
      ],
      {
        bridgeSessionId: "bridge-1",
        projectKey: "/repo/demo",
        canonicalCwd: "/repo/demo",
        createdAt: "2026-04-05T10:00:00.000Z",
        updatedAt: "2026-04-05T10:00:00.000Z",
        status: "active",
        mirrors: {},
        lastWrittenOffsets: [],
      },
    );

    expect(result.linesProcessed).toBe(2);
    expect(result.conversation.status).toBe("conflicted");
  });

  it("parses hook payload JSON from stdin", () => {
    expect(
      parseClaudeHookPayload(
        JSON.stringify({
          session_id: "claude-1",
          transcript_path: "/tmp/transcript.jsonl",
          cwd: "/repo/demo",
        }),
      ),
    ).toEqual({
      session_id: "claude-1",
      transcript_path: "/tmp/transcript.jsonl",
      cwd: "/repo/demo",
    });
  });

  it("imports the latest foreign session into Claude storage on session start", async () => {
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
    await writeEnabledConfig(homeDir, projectDir);

    const result = await runClaudeSessionStart(
      {
        cwd: projectDir,
      },
      {
        homeDir,
        registryPath,
        now: new Date("2026-04-05T10:05:00.000Z"),
      },
    );

    expect(result.imported).toBe(true);
    expect(
      result.result?.conversation.mirrors.claude?.sessionPath,
    ).toBeTruthy();
    expect(
      await readClaudeCodeSession(
        result.result!.conversation.mirrors.claude!.sessionPath,
      ),
    ).toHaveLength(3);
  });

  it("syncs the active Claude transcript into Pi and Codex mirrors on stop", async () => {
    const { homeDir, projectDir, registryPath } = await makeTempWorkspace();
    const transcriptPath = join(
      homeDir,
      ".claude",
      "projects",
      "demo",
      "claude-session.jsonl",
    );

    await writeAdjustedFixture(
      join(fixturesDir, "claude-session.jsonl"),
      transcriptPath,
      projectDir,
    );
    await writeEnabledConfig(homeDir, projectDir);

    const result = await runClaudeStop(
      {
        session_id: "claude-session-1",
        transcript_path: transcriptPath,
        cwd: projectDir,
      },
      {
        homeDir,
        registryPath,
        now: new Date("2026-04-05T10:05:00.000Z"),
      },
    );

    expect(result.synced).toBe(true);
    expect(
      result.result?.writes.find((write) => write.targetTool === "pi")
        ?.appendedCount,
    ).toBe(3);
    expect(
      result.result?.writes.find((write) => write.targetTool === "codex")
        ?.appendedCount,
    ).toBeGreaterThan(3);
  });
});
