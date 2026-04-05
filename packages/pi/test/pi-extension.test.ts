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
  handleMessageEnd,
  handleSessionStart,
  restorePiBridgeState,
  runPiMessageSync,
  runPiSessionImport,
  serializePiBridgeState,
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
    fs.mkdtemp(join(tmpdir(), "agent-session-bridge-pi-")),
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
  config.directions["pi->claude"] = true;
  config.directions["pi->codex"] = true;

  const configPath = join(homeDir, ".agent-session-bridge", "config.json");
  await mkdir(join(configPath, ".."), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify(serializeBridgeConfig(config), null, 2)}\n`,
    "utf8",
  );
}

describe("pi extension", () => {
  it("attaches a Claude mirror on session start", () => {
    const conversation = handleSessionStart({
      bridgeConversation: {
        bridgeSessionId: "bridge-1",
        projectKey: "/repo/demo",
        canonicalCwd: "/repo/demo",
        createdAt: "2026-04-05T10:00:00.000Z",
        updatedAt: "2026-04-05T10:00:00.000Z",
        status: "active",
        mirrors: {},
        lastWrittenOffsets: [],
      },
      mirrorSessionId: "claude-1",
      mirrorPath: "/tmp/claude-1.jsonl",
      timestamp: "2026-04-05T10:01:00.000Z",
    });

    expect(conversation.mirrors.claude?.nativeId).toBe("claude-1");
  });

  it("passes message_end entries through for downstream conversion", () => {
    const entry = {
      type: "message",
      id: "1",
      message: { role: "user", content: "hello" },
    };
    expect(handleMessageEnd(entry).id).toBe("1");
  });

  it("serializes and restores bridge state for reload recovery", () => {
    const state = {
      mirrorSessionId: "claude-1",
      mirrorPath: "/tmp/claude-1.jsonl",
      updatedAt: "2026-04-05T10:01:00.000Z",
    };

    expect(restorePiBridgeState(serializePiBridgeState(state))).toEqual(state);
  });

  it("imports the latest foreign session into Pi storage on session start", async () => {
    const { homeDir, projectDir, registryPath } = await makeTempWorkspace();
    const claudeSessionPath = join(
      homeDir,
      ".claude",
      "projects",
      "demo",
      "claude-session.jsonl",
    );

    await writeAdjustedFixture(
      join(fixturesDir, "claude-session.jsonl"),
      claudeSessionPath,
      projectDir,
    );
    await writeEnabledConfig(homeDir, projectDir);

    const result = await runPiSessionImport(projectDir, {
      homeDir,
      registryPath,
      now: new Date("2026-04-05T10:05:00.000Z"),
    });

    expect(result.imported).toBe(true);
    expect(result.result?.conversation.mirrors.pi?.sessionPath).toBeTruthy();
  });

  it("syncs the active Pi session into Claude and Codex mirrors on message end", async () => {
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

    const result = await runPiMessageSync(piSessionPath, "pi-session-1", {
      homeDir,
      registryPath,
      cwd: projectDir,
      now: new Date("2026-04-05T10:05:00.000Z"),
    });

    expect(
      result.writes.find((write) => write.targetTool === "claude")
        ?.appendedCount,
    ).toBe(3);
    expect(
      result.writes.find((write) => write.targetTool === "codex")
        ?.appendedCount,
    ).toBeGreaterThan(3);
    expect(
      await readClaudeCodeSession(
        result.conversation.mirrors.claude!.sessionPath,
      ),
    ).toHaveLength(3);
  });
});
