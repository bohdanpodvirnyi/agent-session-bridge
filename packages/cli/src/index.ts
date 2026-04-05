#!/usr/bin/env node

import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  createDefaultConfig,
  findConversationByBridgeSessionId,
  findConversationByProjectKey,
  importLatestSessionToTarget,
  listForeignSessionCandidates,
  loadRegistry,
  saveRegistry,
  serializeBridgeConfig,
  setRepairState,
  syncSourceSessionToTargets,
  upsertConversation,
  type BridgeConfig,
  type BridgeRegistry,
  type ToolName,
} from "agent-session-bridge-core";

export interface CliDeps {
  load(): Promise<BridgeRegistry>;
  save(registry: BridgeRegistry): Promise<void>;
  stdout(line: string): void;
  cwd?: string;
  homeDir?: string;
  readFile?: typeof fs.readFile;
  writeFile?: typeof fs.writeFile;
  mkdir?: typeof fs.mkdir;
  lstat?: typeof fs.lstat;
  unlink?: typeof fs.unlink;
  symlink?: typeof fs.symlink;
  rm?: typeof fs.rm;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function readOption(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function withoutFlags(args: string[]): string[] {
  const result: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value.startsWith("--")) {
      if (value === "--cwd" || value === "--tool") {
        index += 1;
      }
      continue;
    }
    result.push(value);
  }

  return result;
}

function resolveHomeDir(deps: CliDeps): string {
  return deps.homeDir ?? homedir();
}

function resolveCwd(deps: CliDeps, argv: string[]): string {
  return resolve(readOption(argv, "--cwd") ?? deps.cwd ?? process.cwd());
}

function resolveRegistryPath(homeDir: string): string {
  return join(homeDir, ".agent-session-bridge", "registry.json");
}

function resolveConfigPath(homeDir: string): string {
  return join(homeDir, ".agent-session-bridge", "config.json");
}

function parseTargetTools(argv: string[]): ToolName[] {
  const tool = readOption(argv, "--tool");
  if (tool === "pi" || tool === "claude" || tool === "codex") {
    return [tool];
  }
  return ["pi", "claude", "codex"];
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}

async function ensureSymlink(
  linkPath: string,
  targetPath: string,
  deps: Pick<CliDeps, "mkdir" | "lstat" | "unlink" | "symlink">,
): Promise<void> {
  const mkdirImpl = deps.mkdir ?? fs.mkdir;
  const lstatImpl = deps.lstat ?? fs.lstat;
  const unlinkImpl = deps.unlink ?? fs.unlink;
  const symlinkImpl = deps.symlink ?? fs.symlink;

  await mkdirImpl(dirname(linkPath), { recursive: true });

  try {
    const existing = await lstatImpl(linkPath);
    if (existing.isSymbolicLink()) {
      const currentTarget = await fs.readlink(linkPath);
      if (resolve(dirname(linkPath), currentTarget) === targetPath) {
        return;
      }
    }
    await unlinkImpl(linkPath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") {
      throw error;
    }
  }

  await symlinkImpl(targetPath, linkPath, "dir");
}

function mergeHookArray(
  current: unknown,
  command: string,
): Array<Record<string, unknown>> {
  const existing = Array.isArray(current) ? current : [];
  const alreadyPresent = existing.some((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return false;
    }
    const hookEntries = Array.isArray((entry as { hooks?: unknown[] }).hooks)
      ? ((entry as { hooks?: unknown[] }).hooks ?? [])
      : [];
    return hookEntries.some(
      (hook) =>
        typeof hook === "object" &&
        hook !== null &&
        (hook as { command?: unknown }).command === command,
    );
  });

  if (alreadyPresent) {
    return existing as Array<Record<string, unknown>>;
  }

  return [
    ...existing,
    {
      matcher: "",
      hooks: [
        {
          type: "command",
          command,
        },
      ],
    },
  ];
}

async function configureClaudeHooks(
  homeDir: string,
  repoRoot: string,
  deps: Pick<CliDeps, "readFile" | "writeFile" | "mkdir">,
): Promise<string> {
  const readFileImpl = deps.readFile ?? fs.readFile;
  const writeFileImpl = deps.writeFile ?? fs.writeFile;
  const mkdirImpl = deps.mkdir ?? fs.mkdir;
  const settingsPath = join(homeDir, ".claude", "settings.json");
  const hookCliPath = join(
    repoRoot,
    "packages",
    "claude-code",
    "dist",
    "claude-code",
    "src",
    "hook-cli.js",
  );
  let settings: Record<string, unknown> = {};

  try {
    settings = JSON.parse(await readFileImpl(settingsPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") {
      throw error;
    }
  }

  const hooks =
    typeof settings.hooks === "object" && settings.hooks !== null
      ? ({ ...(settings.hooks as Record<string, unknown>) } satisfies Record<
          string,
          unknown
        >)
      : {};

  hooks.SessionStart = mergeHookArray(
    hooks.SessionStart,
    `node ${hookCliPath} session-start`,
  );
  hooks.Stop = mergeHookArray(hooks.Stop, `node ${hookCliPath} stop`);
  settings.hooks = hooks;

  await mkdirImpl(dirname(settingsPath), { recursive: true });
  await writeFileImpl(
    `${settingsPath}`,
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf8",
  );

  return settingsPath;
}

async function configureCodexHooks(
  homeDir: string,
  repoRoot: string,
  deps: Pick<CliDeps, "writeFile" | "mkdir">,
): Promise<string> {
  const writeFileImpl = deps.writeFile ?? fs.writeFile;
  const mkdirImpl = deps.mkdir ?? fs.mkdir;
  const hooksPath = join(homeDir, ".codex", "hooks.json");
  const hookCliPath = join(
    repoRoot,
    "packages",
    "codex",
    "dist",
    "codex",
    "src",
    "hook-cli.js",
  );

  const hooks = {
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume",
          hooks: [
            {
              type: "command",
              command: `node ${hookCliPath} session-start`,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: `node ${hookCliPath} stop`,
            },
          ],
        },
      ],
    },
  };

  await mkdirImpl(dirname(hooksPath), { recursive: true });
  await writeFileImpl(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`, "utf8");

  return hooksPath;
}

async function configurePiExtension(
  homeDir: string,
  repoRoot: string,
  deps: Pick<CliDeps, "readFile" | "writeFile" | "mkdir" | "rm">,
): Promise<string> {
  const readFileImpl = deps.readFile ?? fs.readFile;
  const writeFileImpl = deps.writeFile ?? fs.writeFile;
  const mkdirImpl = deps.mkdir ?? fs.mkdir;
  const rmImpl = deps.rm ?? fs.rm;
  const settingsPath = join(homeDir, ".pi", "agent", "settings.json");
  const packageSource = join(repoRoot, "packages", "pi");
  const legacyExtensionPath = join(
    homeDir,
    ".pi",
    "agent",
    "extensions",
    "agent-session-bridge",
  );

  let settings: Record<string, unknown> = {};

  try {
    settings = JSON.parse(await readFileImpl(settingsPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") {
      throw error;
    }
  }

  const packages = Array.isArray(settings.packages)
    ? settings.packages.filter((value): value is string => typeof value === "string")
    : [];

  if (!packages.includes(packageSource)) {
    packages.push(packageSource);
  }
  settings.packages = packages;

  await mkdirImpl(dirname(settingsPath), { recursive: true });
  await writeFileImpl(
    settingsPath,
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf8",
  );
  await rmImpl(legacyExtensionPath, { force: true, recursive: true });

  return settingsPath;
}

async function writeBridgeConfig(
  homeDir: string,
  cwd: string,
  deps: Pick<CliDeps, "writeFile" | "mkdir">,
): Promise<string> {
  const writeFileImpl = deps.writeFile ?? fs.writeFile;
  const mkdirImpl = deps.mkdir ?? fs.mkdir;
  const configPath = resolveConfigPath(homeDir);
  const config: BridgeConfig = {
    ...createDefaultConfig(),
    optIn: true,
    enabledProjects: uniqueBy([cwd], (value) => value),
    directions: {
      ...createDefaultConfig().directions,
      "pi->claude": true,
      "pi->codex": true,
      "claude->pi": true,
      "claude->codex": true,
      "codex->pi": true,
      "codex->claude": true,
    },
  };

  await mkdirImpl(dirname(configPath), { recursive: true });
  await writeFileImpl(
    configPath,
    `${JSON.stringify(serializeBridgeConfig(config), null, 2)}\n`,
    "utf8",
  );
  return configPath;
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...restWithFlags] = argv;
  const rest = withoutFlags(restWithFlags);
  const dryRun = hasFlag(restWithFlags, "--dry-run");
  const importMode = hasFlag(restWithFlags, "--all") ? "--all" : "--latest";
  const registry = await deps.load();
  const homeDir = resolveHomeDir(deps);
  const cwd = resolveCwd(deps, restWithFlags);
  const repoRoot = deps.cwd ? resolve(deps.cwd) : resolve(process.cwd());
  const targetTools = parseTargetTools(restWithFlags);

  if (!command || command === "list") {
    for (const conversation of registry.conversations) {
      deps.stdout(
        `${conversation.bridgeSessionId} ${conversation.projectKey} ${conversation.status}`,
      );
    }
    return 0;
  }

  if (command === "setup") {
    const actions = [
      `config -> ${resolveConfigPath(homeDir)}`,
      `claude -> ${join(homeDir, ".claude", "settings.json")}`,
      `codex -> ${join(homeDir, ".codex", "hooks.json")}`,
      `pi -> ${join(homeDir, ".pi", "agent", "settings.json")}`,
    ];

    if (!dryRun) {
      await writeBridgeConfig(homeDir, cwd, deps);
      await configureClaudeHooks(homeDir, repoRoot, deps);
      await configureCodexHooks(homeDir, repoRoot, deps);
      await configurePiExtension(homeDir, repoRoot, deps);
    }

    deps.stdout(
      `setup complete${dryRun ? " (dry-run)" : ""}: ${actions.join(", ")}`,
    );
    return 0;
  }

  if (command === "import") {
    if (importMode === "--latest") {
      let importedCount = 0;
      for (const targetTool of targetTools) {
        const result = await importLatestSessionToTarget({
          targetTool,
          cwd,
          homeDir,
          registryPath: resolveRegistryPath(homeDir),
        });
        if (result.imported) {
          importedCount += 1;
        }
        deps.stdout(
          `import ${targetTool}: ${
            result.imported
              ? (result.candidate?.id ?? "imported")
              : "no candidate"
          }${dryRun ? " (dry-run ignored for imports)" : ""}`,
        );
      }
      return importedCount > 0 ? 0 : 1;
    }

    const candidates = await listForeignSessionCandidates(cwd, homeDir);
    let importedCount = 0;

    for (const candidate of candidates) {
      for (const targetTool of targetTools) {
        if (targetTool === candidate.sourceTool) {
          continue;
        }
        const result = await syncSourceSessionToTargets({
          sourceTool: candidate.sourceTool,
          sourcePath: candidate.path,
          sourceSessionId: candidate.id,
          registryPath: resolveRegistryPath(homeDir),
          homeDir,
          targetTools: [targetTool],
        });
        importedCount += result.writes.reduce(
          (count, write) => count + write.appendedCount,
          0,
        );
      }
    }

    deps.stdout(`imported ${importedCount} entries in ${importMode}`);
    return 0;
  }

  if (command === "link") {
    const [bridgeSessionId, projectKey] = rest;
    if (!bridgeSessionId || !projectKey) {
      deps.stdout("usage: link <bridgeSessionId> <projectKey>");
      return 1;
    }

    if (!dryRun) {
      const now = new Date().toISOString();
      const next = upsertConversation(registry, {
        bridgeSessionId,
        projectKey,
        canonicalCwd: projectKey,
        createdAt: now,
        updatedAt: now,
        status: "active",
        mirrors: {},
        lastWrittenOffsets: [],
      });
      await deps.save(next);
    }
    deps.stdout(
      `linked ${bridgeSessionId} -> ${projectKey}${dryRun ? " (dry-run)" : ""}`,
    );
    return 0;
  }

  if (command === "repair") {
    const [bridgeSessionId] = rest;
    const conversation = bridgeSessionId
      ? findConversationByBridgeSessionId(registry, bridgeSessionId)
      : undefined;

    if (!conversation) {
      deps.stdout("conversation not found");
      return 1;
    }

    if (!dryRun) {
      const updated = upsertConversation(
        registry,
        setRepairState(conversation, {
          status: "running",
          reason: "manual repair requested",
          updatedAt: new Date().toISOString(),
        }),
      );
      await deps.save(updated);
    }
    deps.stdout(
      `repair queued for ${bridgeSessionId}${dryRun ? " (dry-run)" : ""}`,
    );
    return 0;
  }

  if (command === "audit") {
    deps.stdout(JSON.stringify(registry, null, 2));
    return 0;
  }

  if (command === "import-project") {
    const [projectKey] = rest;
    const conversation = projectKey
      ? findConversationByProjectKey(registry, projectKey)
      : undefined;
    deps.stdout(
      conversation ? conversation.bridgeSessionId : "no conversation",
    );
    return 0;
  }

  deps.stdout(`unknown command: ${command}`);
  return 1;
}

async function main(): Promise<number> {
  const homeDir = homedir();
  const registryPath = resolveRegistryPath(homeDir);

  return runCli(process.argv.slice(2), {
    homeDir,
    cwd: process.cwd(),
    load: () =>
      loadRegistry(registryPath, {
        readFile: fs.readFile,
      }),
    save: (registry) =>
      saveRegistry(registryPath, registry, {
        mkdir: async (path, options) => {
          await fs.mkdir(path, options);
        },
        writeFile: fs.writeFile,
        rename: fs.rename,
      }),
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    mkdir: fs.mkdir,
    lstat: fs.lstat,
    unlink: fs.unlink,
    symlink: fs.symlink,
    rm: fs.rm,
    stdout: (line) => {
      console.log(line);
    },
  });
}

main().then((code) => {
  process.exitCode = code;
});
