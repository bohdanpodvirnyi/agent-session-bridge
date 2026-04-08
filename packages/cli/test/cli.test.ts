import {
  access,
  lstat,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  getClaudeCodeProjectDir,
  getPiSessionDir,
  loadRegistry,
  readClaudeCodeSession,
  syncSourceSessionToTargets,
} from "agent-session-bridge-core";

import { isCliEntrypoint, runCli } from "../src/index.js";

const fixturesDir = join(
  import.meta.dirname,
  "..",
  "..",
  "core",
  "test",
  "fixtures",
);
const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

function runtimeRootFor(homeDir: string): string {
  return join(homeDir, ".agent-session-bridge", "runtime");
}

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
    fs.mkdtemp(join(tmpdir(), "agent-session-bridge-cli-")),
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

describe("CLI", () => {
  it("lists conversations", async () => {
    const lines: string[] = [];

    const exitCode = await runCli(["list"], {
      async load() {
        return {
          version: 1,
          conversations: [
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
          ],
        };
      },
      async save() {},
      stdout(line) {
        lines.push(line);
      },
    });

    expect(exitCode).toBe(0);
    expect(lines[0]).toContain("bridge-1");
  });

  it("links a conversation to a project", async () => {
    let saved = false;

    const exitCode = await runCli(["link", "bridge-1", "/repo/demo"], {
      async load() {
        return { version: 1, conversations: [] };
      },
      async save() {
        saved = true;
      },
      stdout() {},
    });

    expect(exitCode).toBe(0);
    expect(saved).toBe(true);
  });

  it("supports dry-run linking without writing", async () => {
    let saved = false;
    const lines: string[] = [];

    const exitCode = await runCli(
      ["link", "bridge-1", "/repo/demo", "--dry-run"],
      {
        async load() {
          return { version: 1, conversations: [] };
        },
        async save() {
          saved = true;
        },
        stdout(line) {
          lines.push(line);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(saved).toBe(false);
    expect(lines[0]).toContain("dry-run");
  });

  it("queues a repair for an existing conversation", async () => {
    let saved = false;
    const exitCode = await runCli(["repair", "bridge-1"], {
      async load() {
        return {
          version: 1,
          conversations: [
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
          ],
        };
      },
      async save() {
        saved = true;
      },
      stdout() {},
    });

    expect(exitCode).toBe(0);
    expect(saved).toBe(true);
  });

  it("repairs Claude sessions by removing empty thinking blocks", async () => {
    const { homeDir, projectDir, registryPath } = await makeTempWorkspace();
    const claudeDir = getClaudeCodeProjectDir(projectDir, homeDir);
    const claudePath = join(claudeDir, "session.jsonl");

    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      claudePath,
      [
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          parentUuid: null,
          sessionId: "session-1",
          cwd: projectDir,
          timestamp: "2026-04-06T00:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "hi" }] },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-1",
          parentUuid: "user-1",
          sessionId: "session-1",
          cwd: projectDir,
          timestamp: "2026-04-06T00:00:01.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "", signature: "" },
              { type: "text", text: "hello" },
            ],
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const exitCode = await runCli(["repair", "--cwd", projectDir], {
      cwd: repoRoot,
      homeDir,
      readFile,
      writeFile,
      mkdir,
      load: () =>
        loadRegistry(registryPath, {
          readFile,
        }),
      save: async () => {},
      stdout() {},
    });

    expect(exitCode).toBe(0);

    const repaired = await readClaudeCodeSession(claudePath);
    expect(repaired).toHaveLength(2);
    expect(repaired[1]?.type).toBe("assistant");
    expect(repaired[1]?.message.content).toEqual([
      { type: "text", text: "hello" },
    ]);
  });

  it("repairs Claude sessions by stripping invalid thinking signatures", async () => {
    const { homeDir, projectDir, registryPath } = await makeTempWorkspace();
    const claudeDir = getClaudeCodeProjectDir(projectDir, homeDir);
    const claudePath = join(claudeDir, "session.jsonl");

    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      claudePath,
      [
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          parentUuid: null,
          sessionId: "session-1",
          cwd: projectDir,
          timestamp: "2026-04-06T00:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "hi" }] },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-1",
          parentUuid: "user-1",
          sessionId: "session-1",
          cwd: projectDir,
          timestamp: "2026-04-06T00:00:01.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "reasoning", signature: "" },
              { type: "text", text: "hello" },
            ],
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const exitCode = await runCli(["repair", "--cwd", projectDir], {
      cwd: repoRoot,
      homeDir,
      readFile,
      writeFile,
      mkdir,
      load: () =>
        loadRegistry(registryPath, {
          readFile,
        }),
      save: async () => {},
      stdout() {},
    });

    expect(exitCode).toBe(0);

    const repaired = await readClaudeCodeSession(claudePath);
    expect(repaired[1]?.message.content).toEqual([
      { type: "thinking", thinking: "reasoning" },
      { type: "text", text: "hello" },
    ]);
  });

  it("reports Codex mirror index drift in doctor output", async () => {
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
    const lines: string[] = [];

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
    cli_version TEXT NOT NULL DEFAULT '',
    first_user_message TEXT NOT NULL DEFAULT '',
    memory_mode TEXT NOT NULL DEFAULT 'enabled'
);
      `,
    ]);

    await writeAdjustedFixture(
      join(fixturesDir, "pi-session.jsonl"),
      piSessionPath,
      projectDir,
    );
    const syncResult = await syncSourceSessionToTargets({
      sourceTool: "pi",
      sourcePath: piSessionPath,
      registryPath,
      homeDir,
      now: new Date("2026-04-05T10:05:00.000Z"),
    });
    await writeFile(
      registryPath,
      `${JSON.stringify(syncResult.registry, null, 2)}\n`,
      "utf8",
    );
    execFileSync("sqlite3", [
      stateDbPath,
      `delete from threads where id='${syncResult.conversation.mirrors.codex!.nativeId}';`,
    ]);

    const exitCode = await runCli(["doctor", "--cwd", projectDir], {
      cwd: repoRoot,
      homeDir,
      readFile,
      writeFile,
      mkdir,
      load: () =>
        loadRegistry(registryPath, {
          readFile,
        }),
      save: async () => {},
      stdout(line) {
        lines.push(line);
      },
    });

    expect(exitCode).toBe(1);
    expect(
      lines.some(
        (line) =>
          line.includes("WARN codex index:") &&
          line.includes("1 mirrors missing threads rows"),
      ),
    ).toBe(true);
  });

  it("reindexes missing Codex thread rows during repair", async () => {
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
    const lines: string[] = [];

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
    cli_version TEXT NOT NULL DEFAULT '',
    first_user_message TEXT NOT NULL DEFAULT '',
    memory_mode TEXT NOT NULL DEFAULT 'enabled'
);
      `,
    ]);

    await writeAdjustedFixture(
      join(fixturesDir, "pi-session.jsonl"),
      piSessionPath,
      projectDir,
    );
    const syncResult = await syncSourceSessionToTargets({
      sourceTool: "pi",
      sourcePath: piSessionPath,
      registryPath,
      homeDir,
      now: new Date("2026-04-05T10:05:00.000Z"),
    });
    await writeFile(
      registryPath,
      `${JSON.stringify(syncResult.registry, null, 2)}\n`,
      "utf8",
    );
    const codexThreadId = syncResult.conversation.mirrors.codex!.nativeId;
    execFileSync("sqlite3", [
      stateDbPath,
      `delete from threads where id='${codexThreadId}';`,
    ]);

    const exitCode = await runCli(["repair", "--cwd", projectDir], {
      cwd: repoRoot,
      homeDir,
      readFile,
      writeFile,
      mkdir,
      load: () =>
        loadRegistry(registryPath, {
          readFile,
        }),
      save: async () => {},
      stdout(line) {
        lines.push(line);
      },
    });

    expect(exitCode).toBe(0);
    const indexedRow = execFileSync("sqlite3", [
      stateDbPath,
      `select id || '|' || title from threads where id='${codexThreadId}';`,
    ])
      .toString()
      .trim();
    expect(indexedRow).toContain(codexThreadId);
    expect(lines.some((line) => line.includes("reindexed 1 Codex mirrors"))).toBe(
      true,
    );
  });

  it("audits the registry as JSON", async () => {
    const lines: string[] = [];
    const exitCode = await runCli(["audit"], {
      async load() {
        return { version: 1, conversations: [] };
      },
      async save() {},
      stdout(line) {
        lines.push(line);
      },
    });

    expect(exitCode).toBe(0);
    expect(lines[0]).toContain('"version": 1');
  });

  it("writes real local integration files during setup", async () => {
    const { homeDir, projectDir, registryPath } = await makeTempWorkspace();
    const lines: string[] = [];

    const exitCode = await runCli(["setup", "--cwd", projectDir], {
      cwd: repoRoot,
      homeDir,
      readFile,
      writeFile,
      mkdir,
      load: () =>
        loadRegistry(registryPath, {
          readFile,
        }),
      save: async () => {},
      stdout(line) {
        lines.push(line);
      },
    });

    expect(exitCode).toBe(0);
    expect(await exists(join(homeDir, ".codex", "hooks.json"))).toBe(true);
    expect(await exists(join(homeDir, ".claude", "settings.json"))).toBe(true);
    expect(await exists(join(homeDir, ".pi", "agent", "settings.json"))).toBe(
      true,
    );
    expect(
      await exists(join(homeDir, ".agent-session-bridge", "config.json")),
    ).toBe(true);
    expect(
      await exists(
        join(
          runtimeRootFor(homeDir),
          "packages",
          "claude-code",
          "dist",
          "claude-code",
          "src",
          "hook-cli.js",
        ),
      ),
    ).toBe(true);
    expect(lines[0]).toContain("setup");

    const piSettings = JSON.parse(
      await readFile(join(homeDir, ".pi", "agent", "settings.json"), "utf8"),
    ) as { packages?: string[] };
    expect(piSettings.packages).toContain(
      join(runtimeRootFor(homeDir), "packages", "pi"),
    );
  });

  it("detects npm-style symlinked CLI entrypoints", async () => {
    const rootDir = await import("node:fs/promises").then((fs) =>
      fs.mkdtemp(join(tmpdir(), "agent-session-bridge-cli-bin-")),
    );
    const targetPath = join(rootDir, "target.js");
    const shimPath = join(
      rootDir,
      "node_modules",
      ".bin",
      "agent-session-bridge",
    );

    await mkdir(join(rootDir, "node_modules", ".bin"), { recursive: true });
    await writeFile(targetPath, "#!/usr/bin/env node\n", "utf8");
    await symlink(targetPath, shimPath);

    expect(isCliEntrypoint(shimPath, pathToFileURL(targetPath).href)).toBe(
      true,
    );
  });

  it("removes stale local Pi package paths during setup", async () => {
    const { homeDir, projectDir, registryPath } = await makeTempWorkspace();
    await mkdir(join(homeDir, ".pi", "agent"), { recursive: true });
    await writeFile(
      join(homeDir, ".pi", "agent", "settings.json"),
      JSON.stringify(
        {
          packages: [
            "/Users/bohdanpodvirnyi/packages/pi",
            join(repoRoot, "packages", "pi"),
            "npm:pi-review-loop",
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const exitCode = await runCli(["setup", "--cwd", projectDir], {
      cwd: repoRoot,
      homeDir,
      readFile,
      writeFile,
      mkdir,
      load: () =>
        loadRegistry(registryPath, {
          readFile,
        }),
      save: async () => {},
      stdout() {},
    });

    expect(exitCode).toBe(0);

    const piSettings = JSON.parse(
      await readFile(join(homeDir, ".pi", "agent", "settings.json"), "utf8"),
    ) as { packages?: string[] };
    expect(piSettings.packages).toContain(
      join(runtimeRootFor(homeDir), "packages", "pi"),
    );
    expect(piSettings.packages).not.toContain(
      "/Users/bohdanpodvirnyi/packages/pi",
    );
    expect(piSettings.packages).toContain("npm:pi-review-loop");
  });

  it("resolves the repo root from the CLI location instead of the launch cwd", async () => {
    const { homeDir, projectDir, registryPath } = await makeTempWorkspace();

    const exitCode = await runCli(["setup", "--cwd", projectDir], {
      cwd: projectDir,
      homeDir,
      readFile,
      writeFile,
      mkdir,
      load: () =>
        loadRegistry(registryPath, {
          readFile,
        }),
      save: async () => {},
      stdout() {},
    });

    expect(exitCode).toBe(0);

    const piSettings = JSON.parse(
      await readFile(join(homeDir, ".pi", "agent", "settings.json"), "utf8"),
    ) as { packages?: string[] };
    expect(piSettings.packages).toContain(
      join(runtimeRootFor(homeDir), "packages", "pi"),
    );
    expect(piSettings.packages).not.toContain(
      join(projectDir, "packages", "pi"),
    );
  });

  it("replaces stale Claude bridge hook commands during setup", async () => {
    const { homeDir, projectDir, registryPath } = await makeTempWorkspace();
    await mkdir(join(homeDir, ".claude"), { recursive: true });
    await writeFile(
      join(homeDir, ".claude", "settings.json"),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                matcher: "",
                hooks: [
                  {
                    type: "command",
                    command:
                      "node /Users/bohdanpodvirnyi/packages/claude-code/dist/claude-code/src/hook-cli.js session-start",
                  },
                ],
              },
            ],
            Stop: [
              {
                matcher: "",
                hooks: [
                  {
                    type: "command",
                    command:
                      "node /Users/bohdanpodvirnyi/packages/claude-code/dist/claude-code/src/hook-cli.js stop",
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const exitCode = await runCli(["setup", "--cwd", projectDir], {
      cwd: repoRoot,
      homeDir,
      readFile,
      writeFile,
      mkdir,
      load: () =>
        loadRegistry(registryPath, {
          readFile,
        }),
      save: async () => {},
      stdout() {},
    });

    expect(exitCode).toBe(0);

    const claudeSettings = JSON.parse(
      await readFile(join(homeDir, ".claude", "settings.json"), "utf8"),
    ) as {
      hooks?: {
        SessionStart?: Array<{
          hooks?: Array<{ command?: string; async?: boolean }>;
        }>;
        Stop?: Array<{
          hooks?: Array<{ command?: string; async?: boolean }>;
        }>;
      };
    };

    const sessionStartHooks =
      claudeSettings.hooks?.SessionStart?.flatMap((entry) =>
        (entry.hooks ?? []).filter((hook) => Boolean(hook.command)),
      ) ?? [];
    const stopHooks =
      claudeSettings.hooks?.Stop?.flatMap((entry) =>
        (entry.hooks ?? []).filter((hook) => Boolean(hook.command)),
      ) ?? [];

    expect(sessionStartHooks).toEqual([
      {
        type: "command",
        command: `node ${join(runtimeRootFor(homeDir), "packages", "claude-code", "dist", "claude-code", "src", "hook-cli.js")} session-start`,
        async: true,
      },
    ]);
    expect(stopHooks).toEqual([
      {
        type: "command",
        command: `node ${join(runtimeRootFor(homeDir), "packages", "claude-code", "dist", "claude-code", "src", "hook-cli.js")} stop`,
        async: true,
      },
    ]);
  });

  it("imports the latest session into the selected target tool", async () => {
    const { homeDir, projectDir, registryPath } = await makeTempWorkspace();
    const piSessionPath = join(
      homeDir,
      ".pi",
      "agent",
      "sessions",
      "--demo-project-source--",
      "pi-session.jsonl",
    );
    const lines: string[] = [];

    await writeAdjustedFixture(
      join(fixturesDir, "pi-session.jsonl"),
      piSessionPath,
      projectDir,
    );

    const exitCode = await runCli(
      ["import", "--latest", "--tool", "claude", "--cwd", projectDir],
      {
        cwd: repoRoot,
        homeDir,
        readFile,
        writeFile,
        mkdir,
        load: () =>
          loadRegistry(registryPath, {
            readFile,
          }),
        save: async () => {},
        stdout(line) {
          lines.push(line);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(lines[0]).toContain("import claude:");

    const claudeProjectsRoot = join(homeDir, ".claude", "projects");
    const projectDirs = await import("node:fs/promises").then((fs) =>
      fs.readdir(claudeProjectsRoot),
    );
    const importedPath = join(
      claudeProjectsRoot,
      projectDirs[0]!,
      (
        await import("node:fs/promises").then((fs) =>
          fs.readdir(join(claudeProjectsRoot, projectDirs[0]!)),
        )
      )[0]!,
    );

    expect((await readClaudeCodeSession(importedPath)).length).toBe(3);
  });

  it("supports bulk import mode", async () => {
    const { homeDir, projectDir, registryPath } = await makeTempWorkspace();
    const piSessionPath = join(
      homeDir,
      ".pi",
      "agent",
      "sessions",
      "--demo-project-source--",
      "pi-session.jsonl",
    );
    const lines: string[] = [];

    await writeAdjustedFixture(
      join(fixturesDir, "pi-session.jsonl"),
      piSessionPath,
      projectDir,
    );

    const exitCode = await runCli(
      ["import", "--all", "--tool", "claude", "--cwd", projectDir],
      {
        cwd: repoRoot,
        homeDir,
        readFile,
        writeFile,
        mkdir,
        load: () =>
          loadRegistry(registryPath, {
            readFile,
          }),
        save: async () => {},
        stdout(line) {
          lines.push(line);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(lines[0]).toContain("imported");
  });

  it("skips malformed source session files during bulk import", async () => {
    const { homeDir, projectDir, registryPath } = await makeTempWorkspace();
    const validPiPath = join(
      homeDir,
      ".pi",
      "agent",
      "sessions",
      "--demo-project-source--",
      "pi-session.jsonl",
    );
    const malformedPiPath = join(
      homeDir,
      ".pi",
      "agent",
      "sessions",
      "--demo-project-bad--",
      "broken.jsonl",
    );
    const lines: string[] = [];

    await writeAdjustedFixture(
      join(fixturesDir, "pi-session.jsonl"),
      validPiPath,
      projectDir,
    );
    await mkdir(join(malformedPiPath, ".."), { recursive: true });
    await writeFile(
      malformedPiPath,
      '{"type":"session","version":1,"id":"broken","timestamp":"2026-04-05T10:00:00.000Z","cwd":"' +
        projectDir +
        '"}\n{"type":"message"} trailing-json\n',
      "utf8",
    );

    const exitCode = await runCli(
      ["import", "--all", "--tool", "claude", "--cwd", projectDir],
      {
        cwd: repoRoot,
        homeDir,
        readFile,
        writeFile,
        mkdir,
        load: () =>
          loadRegistry(registryPath, {
            readFile,
          }),
        save: async () => {},
        stdout(line) {
          lines.push(line);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(lines[0]).toContain("imported");

    const claudeProjectsRoot = join(homeDir, ".claude", "projects");
    const projectDirs = await import("node:fs/promises").then((fs) =>
      fs.readdir(claudeProjectsRoot),
    );
    const importedPath = join(
      claudeProjectsRoot,
      projectDirs[0]!,
      (
        await import("node:fs/promises").then((fs) =>
          fs.readdir(join(claudeProjectsRoot, projectDirs[0]!)),
        )
      )[0]!,
    );

    expect((await readClaudeCodeSession(importedPath)).length).toBe(3);
  });

  it("enables bridge sync for the current project without overwriting config", async () => {
    const { homeDir, projectDir, registryPath } = await makeTempWorkspace();
    const configDir = join(homeDir, ".agent-session-bridge");
    const configPath = join(configDir, "config.json");
    const lines: string[] = [];

    await mkdir(configDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify(
        {
          optIn: true,
          enabledProjects: ["/tmp/existing-project"],
          disabledProjects: [],
          directions: {
            "pi->pi": false,
            "pi->claude": true,
            "pi->codex": false,
            "claude->pi": true,
            "claude->claude": false,
            "claude->codex": false,
            "codex->pi": false,
            "codex->claude": false,
            "codex->codex": false,
          },
          redactionPatterns: [{ source: "secret", flags: "g" }],
        },
        null,
        2,
      ),
      "utf8",
    );

    const exitCode = await runCli(["enable", "--cwd", projectDir], {
      cwd: repoRoot,
      homeDir,
      readFile,
      writeFile,
      mkdir,
      load: () =>
        loadRegistry(registryPath, {
          readFile,
        }),
      save: async () => {},
      stdout(line) {
        lines.push(line);
      },
    });

    expect(exitCode).toBe(0);
    expect(lines[0]).toContain("enabled");

    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      optIn: boolean;
      enabledProjects: string[];
      directions: Record<string, boolean>;
    };
    expect(config.optIn).toBe(true);
    expect(config.enabledProjects).toContain("/tmp/existing-project");
    expect(config.enabledProjects).toContain(projectDir);
    expect(config.directions["codex->pi"]).toBe(true);
  });

  it("reports installation and sync health in doctor", async () => {
    const { homeDir, projectDir, registryPath } = await makeTempWorkspace();
    const lines: string[] = [];

    await runCli(["setup", "--cwd", projectDir], {
      cwd: repoRoot,
      homeDir,
      readFile,
      writeFile,
      mkdir,
      load: () =>
        loadRegistry(registryPath, {
          readFile,
        }),
      save: async () => {},
      stdout() {},
    });

    await mkdir(join(homeDir, ".agent-session-bridge", "claude-code-hooks"), {
      recursive: true,
    });
    await mkdir(join(homeDir, ".agent-session-bridge", "codex-hooks"), {
      recursive: true,
    });
    await writeFile(
      join(homeDir, ".agent-session-bridge", "claude-code-hooks", "stop.json"),
      JSON.stringify({ receivedAt: "2026-04-05T12:00:00.000Z" }, null, 2),
      "utf8",
    );
    await writeFile(
      join(homeDir, ".agent-session-bridge", "codex-hooks", "stop.json"),
      JSON.stringify({ receivedAt: "2026-04-05T12:05:00.000Z" }, null, 2),
      "utf8",
    );

    const exitCode = await runCli(["doctor", "--cwd", projectDir], {
      cwd: repoRoot,
      homeDir,
      readFile,
      writeFile,
      mkdir,
      load: () =>
        loadRegistry(registryPath, {
          readFile,
        }),
      save: async () => {},
      stdout(line) {
        lines.push(line);
      },
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("OK pi:");
    expect(lines.join("\n")).toContain("OK claude:");
    expect(lines.join("\n")).toContain("OK codex:");
    expect(lines.join("\n")).toContain(
      "last stop hook: 2026-04-05T12:05:00.000Z",
    );
  });

  it("repairs imported Pi sessions for the current project", async () => {
    const { homeDir, projectDir, registryPath } = await makeTempWorkspace();
    const lines: string[] = [];
    const piDir = getPiSessionDir(projectDir, homeDir);
    const piSessionPath = join(piDir, "broken.jsonl");

    await mkdir(piDir, { recursive: true });
    await writeFile(
      piSessionPath,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "pi-broken",
          timestamp: "2026-04-05T10:00:00.000Z",
          cwd: projectDir,
        }),
        JSON.stringify({
          type: "message",
          id: "m1",
          parentId: null,
          timestamp: "2026-04-05T10:00:01.000Z",
          message: {
            role: "user",
            content: [
              { type: "text", text: "<permissions instructions>" },
              {
                type: "text",
                text: "Filesystem sandboxing defines which files can be read or written.",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "m2",
          parentId: "m1",
          timestamp: "2026-04-05T10:00:02.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: 'Staging file.\n\n::git-stage{cwd="/repo/demo"}\n\nPushed.',
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "m3",
          parentId: "m2",
          timestamp: "2026-04-05T10:00:03.000Z",
          message: {
            role: "user",
            content: "real prompt",
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const exitCode = await runCli(["repair", "--cwd", projectDir], {
      cwd: repoRoot,
      homeDir,
      readFile,
      writeFile,
      mkdir,
      lstat,
      load: () =>
        loadRegistry(registryPath, {
          readFile,
        }),
      save: async () => {},
      stdout(line) {
        lines.push(line);
      },
    });

    expect(exitCode).toBe(0);
    expect(lines[0]).toContain("repair complete");

    const repaired = (await readFile(piSessionPath, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            message?: { content?: unknown; usage?: unknown };
          },
      );

    expect(repaired).toHaveLength(3);
    expect(repaired[1]?.message?.content).toEqual([
      { type: "text", text: "Staging file.\n\nPushed." },
    ]);
    expect(repaired[1]?.message?.usage).toMatchObject({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { total: 0 },
    });
    expect(repaired[2]?.message?.content).toBe("real prompt");
  });
});
