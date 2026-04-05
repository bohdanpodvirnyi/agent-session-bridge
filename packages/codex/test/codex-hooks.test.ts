import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  createDefaultConfig,
  generateCodexThreadId,
  isCodexThreadId,
  readCodexRollout,
  serializeBridgeConfig,
} from "agent-session-bridge-core";

import {
  buildExperimentalRollout,
  discoverRolloutPath,
  parseCodexHookPayload,
  registerCodexMirror,
  runCodexSessionStart,
  runCodexStop,
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
    fs.mkdtemp(join(tmpdir(), "agent-session-bridge-codex-")),
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
  config.directions["codex->pi"] = true;
  config.directions["codex->claude"] = true;

  const configPath = join(homeDir, ".agent-session-bridge", "config.json");
  await mkdir(join(configPath, ".."), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify(serializeBridgeConfig(config), null, 2)}\n`,
    "utf8",
  );
}

describe("codex hooks", () => {
  it("discovers a rollout path from session context", () => {
    const date = new Date(2026, 3, 5, 10, 0, 0);
    const threadId = generateCodexThreadId(date);
    const path = discoverRolloutPath(
      threadId,
      date,
      "/tmp/demo/.codex",
    );
    expect(path).toBe(
      join(
        "/tmp/demo/.codex",
        "sessions",
        "2026",
        "04",
        "05",
        `rollout-2026-04-05T10-00-00-${threadId}.jsonl`,
      ),
    );
  });

  it("builds an experimental rollout with resumable task envelopes", () => {
    const threadId = generateCodexThreadId(new Date(2026, 3, 5, 10, 0, 0));
    const rollout = buildExperimentalRollout(
      [
        {
          id: "message-1",
          role: "assistant",
          timestamp: "2026-04-05T10:00:00.000Z",
          content: [{ type: "text", text: "hello" }],
        },
      ],
      "/repo/demo",
      threadId,
    );

    expect(rollout.map((item) => item.type)).toEqual([
      "session_meta",
      "event_msg",
      "turn_context",
      "response_item",
      "event_msg",
      "event_msg",
    ]);
    expect(isCodexThreadId(rollout[0]!.payload.id)).toBe(true);
  });

  it("parses hook payloads and registers a Codex mirror", () => {
    expect(
      parseCodexHookPayload(
        JSON.stringify({ session_id: "thread-1", cwd: "/repo/demo" }),
      ),
    ).toEqual({
      session_id: "thread-1",
      cwd: "/repo/demo",
    });

    const conversation = registerCodexMirror(
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
      "thread-1",
      "/repo/demo/.codex/sessions/2026/04/05/rollout-thread-1.jsonl",
      "2026-04-05T10:01:00.000Z",
    );

    expect(conversation.mirrors.codex?.nativeId).toBe("thread-1");
  });

  it("imports the latest foreign session into Codex storage on session start", async () => {
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

    const result = await runCodexSessionStart(
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
    expect(result.result?.conversation.mirrors.codex?.sessionPath).toBeTruthy();
    expect(
      (
        await readCodexRollout(
          result.result!.conversation.mirrors.codex!.sessionPath,
        )
      )[0]?.type,
    ).toBe("session_meta");
  });

  it("syncs the active Codex rollout into Pi and Claude mirrors on stop", async () => {
    const { homeDir, projectDir, registryPath } = await makeTempWorkspace();
    const rolloutPath = join(
      homeDir,
      ".codex",
      "sessions",
      "2026",
      "04",
      "05",
      "rollout-codex-session-1.jsonl",
    );

    await writeAdjustedFixture(
      join(fixturesDir, "codex-rollout.jsonl"),
      rolloutPath,
      projectDir,
    );
    await writeEnabledConfig(homeDir, projectDir);

    const result = await runCodexStop(
      {
        session_id: "codex-session-1",
        cwd: projectDir,
      },
      {
        homeDir,
        registryPath,
        now: new Date("2026-04-05T10:05:00.000Z"),
      },
    );

    expect(result.synced).toBe(true);
    expect(result.rolloutPath).toBe(rolloutPath);
    expect(
      result.result?.writes.find((write) => write.targetTool === "pi")
        ?.appendedCount,
    ).toBe(3);
    expect(
      result.result?.writes.find((write) => write.targetTool === "claude")
        ?.appendedCount,
    ).toBe(3);
  });
});
