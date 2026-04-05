import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { loadRegistry, readClaudeCodeSession } from "agent-session-bridge-core";

import { runCli } from "../src/index.js";

const fixturesDir = join(
  import.meta.dirname,
  "..",
  "..",
  "core",
  "test",
  "fixtures",
);
const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

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
    expect(lines[0]).toContain("setup complete");

    const piSettings = JSON.parse(
      await readFile(join(homeDir, ".pi", "agent", "settings.json"), "utf8"),
    ) as { packages?: string[] };
    expect(piSettings.packages).toContain(join(repoRoot, "packages", "pi"));
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
});
