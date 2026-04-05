import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  encodeCwdForPi,
  getClaudeCodeProjectDir,
  loadSourceSessionSnapshot,
  normalizePath,
  readPiSession,
  syncSourceSessionToTargets,
  type ToolName,
} from "../src/index.js";

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ToolSessionResult {
  sessionId: string;
  sessionPath: string;
  finalText: string;
  stdout: string;
  stderr: string;
}

interface PairContext {
  rootDir: string;
  projectDir: string;
  registryPath: string;
  cleanupPaths: Set<string>;
}

const repoHome = homedir();
const realAgentsEnabled = process.env.REAL_AGENT_E2E === "1";

const pairs = [
  ["pi", "claude"],
  ["pi", "codex"],
  ["claude", "pi"],
  ["claude", "codex"],
  ["codex", "pi"],
  ["codex", "claude"],
] as const satisfies ReadonlyArray<readonly [ToolName, ToolName]>;

function tokenFor(source: ToolName, target: ToolName, phase: string): string {
  return `ASB_${source.toUpperCase()}_${target.toUpperCase()}_${phase}`;
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `Timed out after ${options.timeoutMs ?? 90_000}ms: ${command} ${args.join(" ")}`,
        ),
      );
    }, options.timeoutMs ?? 90_000);

    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function extractJsonObjects(raw: string): unknown[] {
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

async function findPiSessionPath(
  sessionRoot: string,
  cwd: string,
  sessionId: string,
): Promise<string> {
  const sessionDir = join(sessionRoot, "sessions", encodeCwdForPi(cwd));
  const entries = await readdir(sessionDir);

  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const candidate = join(sessionDir, entry);
    const session = await readPiSession(candidate);
    if (session.header.id === sessionId) {
      return candidate;
    }
  }

  throw new Error(`Could not find Pi session ${sessionId} in ${sessionDir}`);
}

async function findCodexRolloutPath(
  sessionId: string,
  homeDir: string,
): Promise<string> {
  const root = join(homeDir, ".codex", "sessions");
  const yearDirs = await readdir(root).catch(() => []);

  for (const yearDir of yearDirs.sort().reverse()) {
    const yearPath = join(root, yearDir);
    const monthDirs = await readdir(yearPath).catch(() => []);
    for (const monthDir of monthDirs.sort().reverse()) {
      const monthPath = join(yearPath, monthDir);
      const dayDirs = await readdir(monthPath).catch(() => []);
      for (const dayDir of dayDirs.sort().reverse()) {
        const dayPath = join(monthPath, dayDir);
        const files = await readdir(dayPath).catch(() => []);
        const directMatch = files.find((file) => file.includes(sessionId));
        if (directMatch) {
          return join(dayPath, directMatch);
        }
      }
    }
  }

  throw new Error(`Could not find Codex rollout for session ${sessionId}`);
}

async function snapshotTexts(
  tool: ToolName,
  sessionPath: string,
): Promise<string[]> {
  const snapshot = await loadSourceSessionSnapshot(tool, sessionPath);
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

async function makePairContext(
  source: ToolName,
  target: ToolName,
): Promise<PairContext> {
  const rootDir = await mkdtemp(
    join(tmpdir(), `asb-real-${source}-${target}-`),
  );
  const projectDir = normalizePath(
    await realpath(
      await mkdir(join(rootDir, "project"), { recursive: true }).then(() =>
        join(rootDir, "project"),
      ),
    ),
  );
  await runCommand("git", ["init", "-q"], {
    cwd: projectDir,
    timeoutMs: 15_000,
  });

  return {
    rootDir,
    projectDir,
    registryPath: join(rootDir, "registry.json"),
    cleanupPaths: new Set<string>(),
  };
}

async function runPiPrompt(params: {
  cwd: string;
  prompt: string;
  sessionPath?: string;
}): Promise<ToolSessionResult> {
  const args = [
    "-p",
    "--mode",
    "json",
    "--no-tools",
    "--no-extensions",
    "--provider",
    "openai-codex",
    "--model",
    "gpt-5.4",
  ];
  if (params.sessionPath) {
    args.push("--session", params.sessionPath);
  }
  args.push(params.prompt);

  const result = await runCommand("pi", args, {
    cwd: params.cwd,
    timeoutMs: 120_000,
  });
  expect(result.code).toBe(0);

  const objects = extractJsonObjects(result.stdout);
  const session = objects.find(
    (value): value is { id: string; type: string } =>
      typeof value === "object" &&
      value !== null &&
      (value as { type?: unknown }).type === "session" &&
      typeof (value as { id?: unknown }).id === "string",
  );
  if (!session) {
    throw new Error(
      `Pi output did not contain a session header.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }

  const sessionPath =
    params.sessionPath ??
    (await findPiSessionPath(
      join(repoHome, ".pi", "agent"),
      normalizePath(await realpath(params.cwd)),
      session.id,
    ));
  const texts = await snapshotTexts("pi", sessionPath);
  const finalText = texts.at(-1) ?? "";

  return {
    sessionId: session.id,
    sessionPath,
    finalText,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function runClaudePrompt(params: {
  cwd: string;
  prompt: string;
  sessionId?: string;
}): Promise<ToolSessionResult> {
  const args = ["-p", "--output-format", "json", "--tools", ""];
  if (params.sessionId) {
    args.push("-r", params.sessionId);
  }
  args.push("--", params.prompt);

  const result = await runCommand("claude", args, {
    cwd: params.cwd,
    timeoutMs: 120_000,
  });
  expect(result.code).toBe(0);

  const parsed = extractJsonObjects(result.stdout).find(
    (value): value is { result: string; session_id: string } =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as { result?: unknown }).result === "string" &&
      typeof (value as { session_id?: unknown }).session_id === "string",
  );
  if (!parsed) {
    throw new Error(
      `Claude output did not contain a result JSON object.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }

  const sessionPath = join(
    getClaudeCodeProjectDir(
      normalizePath(await realpath(params.cwd)),
      repoHome,
    ),
    `${parsed.session_id}.jsonl`,
  );

  return {
    sessionId: parsed.session_id,
    sessionPath,
    finalText: parsed.result,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function runCodexPrompt(params: {
  cwd: string;
  prompt: string;
  sessionId?: string;
}): Promise<ToolSessionResult> {
  const outputFile = join(
    await mkdtemp(join(tmpdir(), "asb-codex-output-")),
    "last-message.txt",
  );
  const args = params.sessionId
    ? [
        "exec",
        "resume",
        params.sessionId,
        "--json",
        "-o",
        outputFile,
        "--disable",
        "codex_hooks",
        params.prompt,
      ]
    : [
        "exec",
        "--json",
        "-o",
        outputFile,
        "--disable",
        "codex_hooks",
        params.prompt,
      ];

  const result = await runCommand("codex", args, {
    cwd: params.cwd,
    timeoutMs: 120_000,
  });
  expect(result.code).toBe(0);

  const parsed = extractJsonObjects(result.stdout);
  const threadStarted = parsed.find(
    (value): value is { thread_id: string; type: string } =>
      typeof value === "object" &&
      value !== null &&
      (value as { type?: unknown }).type === "thread.started" &&
      typeof (value as { thread_id?: unknown }).thread_id === "string",
  );
  const sessionId = params.sessionId ?? threadStarted?.thread_id;
  if (!sessionId) {
    throw new Error(
      `Codex output did not contain a thread id.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }

  const finalText = (await readFile(outputFile, "utf8")).trim();
  const sessionPath = await findCodexRolloutPath(sessionId, repoHome);

  return {
    sessionId,
    sessionPath,
    finalText,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function runToolPrompt(
  tool: ToolName,
  params: {
    cwd: string;
    prompt: string;
    sessionId?: string;
    sessionPath?: string;
  },
): Promise<ToolSessionResult> {
  if (tool === "pi") {
    return runPiPrompt({
      cwd: params.cwd,
      prompt: params.prompt,
      sessionPath: params.sessionPath,
    });
  }
  if (tool === "claude") {
    return runClaudePrompt({
      cwd: params.cwd,
      prompt: params.prompt,
      sessionId: params.sessionId,
    });
  }
  return runCodexPrompt({
    cwd: params.cwd,
    prompt: params.prompt,
    sessionId: params.sessionId,
  });
}

describe.runIf(realAgentsEnabled)("real command end to end", () => {
  it("round-trips every ordered tool pair with real commands and native session files", async () => {
    for (const [sourceTool, targetTool] of pairs) {
      const context = await makePairContext(sourceTool, targetTool);
      const sourcePrompt = `Reply with exactly ${tokenFor(sourceTool, targetTool, "SOURCE")}`;
      const targetPrompt = `Reply with exactly ${tokenFor(sourceTool, targetTool, "TARGET")}`;
      const roundtripPrompt = `Reply with exactly ${tokenFor(sourceTool, targetTool, "ROUNDTRIP")}`;

      try {
        const sourceResult = await runToolPrompt(sourceTool, {
          cwd: context.projectDir,
          prompt: sourcePrompt,
        });
        context.cleanupPaths.add(sourceResult.sessionPath);
        expect(sourceResult.finalText).toContain(
          tokenFor(sourceTool, targetTool, "SOURCE"),
        );

        const importResult = await syncSourceSessionToTargets({
          sourceTool,
          sourcePath: sourceResult.sessionPath,
          sourceSessionId: sourceResult.sessionId,
          registryPath: context.registryPath,
          homeDir: repoHome,
          targetTools: [targetTool],
        });
        for (const write of importResult.writes) {
          context.cleanupPaths.add(write.sessionPath);
        }

        const targetMirror = importResult.writes.find(
          (write) => write.targetTool === targetTool,
        );
        expect(targetMirror).toBeDefined();
        const importedTargetTexts = await snapshotTexts(
          targetTool,
          targetMirror!.sessionPath,
        );
        expect(importedTargetTexts.join("\n")).toContain(
          tokenFor(sourceTool, targetTool, "SOURCE"),
        );

        const targetResult = await runToolPrompt(targetTool, {
          cwd: context.projectDir,
          prompt: targetPrompt,
          sessionId:
            targetTool === "pi" ? undefined : targetMirror!.targetSessionId,
          sessionPath:
            targetTool === "pi" ? targetMirror!.sessionPath : undefined,
        });
        expect(targetResult.finalText).toContain(
          tokenFor(sourceTool, targetTool, "TARGET"),
        );

        const roundtripImport = await syncSourceSessionToTargets({
          sourceTool: targetTool,
          sourcePath: targetMirror!.sessionPath,
          sourceSessionId:
            targetTool === "pi"
              ? targetMirror!.targetSessionId
              : targetResult.sessionId,
          registryPath: context.registryPath,
          homeDir: repoHome,
          targetTools: [sourceTool],
        });
        for (const write of roundtripImport.writes) {
          context.cleanupPaths.add(write.sessionPath);
        }

        const sourceTextsAfterRoundtrip = await snapshotTexts(
          sourceTool,
          sourceResult.sessionPath,
        );
        expect(sourceTextsAfterRoundtrip.join("\n")).toContain(
          tokenFor(sourceTool, targetTool, "TARGET"),
        );

        const roundtripResult = await runToolPrompt(sourceTool, {
          cwd: context.projectDir,
          prompt: roundtripPrompt,
          sessionId: sourceTool === "pi" ? undefined : sourceResult.sessionId,
          sessionPath:
            sourceTool === "pi" ? sourceResult.sessionPath : undefined,
        });
        expect(roundtripResult.finalText).toContain(
          tokenFor(sourceTool, targetTool, "ROUNDTRIP"),
        );
      } finally {
        for (const path of context.cleanupPaths) {
          await rm(path, { force: true });
        }
        await rm(context.rootDir, { recursive: true, force: true });
      }
    }
  }, 1_200_000);
});
