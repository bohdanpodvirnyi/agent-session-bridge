#!/usr/bin/env node

import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createDefaultConfig,
  findConversationByBridgeSessionId,
  findConversationByProjectKey,
  getClaudeCodeProjectDir,
  getPiSessionDir,
  importLatestSessionToTarget,
  isProjectEnabled,
  listForeignSessionCandidates,
  loadBridgeConfig,
  loadRegistry,
  saveRegistry,
  serializeBridgeConfig,
  setRepairState,
  syncSourceSessionToTargets,
  upsertConversation,
  type BridgeConfig,
  type BridgeRegistry,
  type ToolName,
} from "../../core/src/index.js";

export interface CliDeps {
  load(): Promise<BridgeRegistry>;
  save(registry: BridgeRegistry): Promise<void>;
  stdout(line: string): void;
  cwd?: string;
  repoRoot?: string;
  homeDir?: string;
  readFile?: typeof fs.readFile;
  writeFile?: typeof fs.writeFile;
  mkdir?: typeof fs.mkdir;
  lstat?: typeof fs.lstat;
  unlink?: typeof fs.unlink;
  symlink?: typeof fs.symlink;
  rm?: typeof fs.rm;
  cp?: typeof fs.cp;
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

function resolveHookStateDir(
  homeDir: string,
  tool: "claude-code" | "codex",
): string {
  return join(homeDir, ".agent-session-bridge", `${tool}-hooks`);
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

async function pathExists(
  path: string,
  deps: Pick<CliDeps, "lstat">,
): Promise<boolean> {
  const lstatImpl = deps.lstat ?? fs.lstat;
  try {
    await lstatImpl(path);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function mergeEnabledProject(
  config: BridgeConfig,
  cwd: string,
  globalMode: boolean,
): BridgeConfig {
  const normalizedEnabled = globalMode
    ? []
    : uniqueBy([...config.enabledProjects, cwd], (value) => value);
  return {
    ...config,
    optIn: true,
    enabledProjects: normalizedEnabled,
    disabledProjects: config.disabledProjects.filter((value) => value !== cwd),
    directions: {
      ...config.directions,
      "pi->claude": true,
      "pi->codex": true,
      "claude->pi": true,
      "claude->codex": true,
      "codex->pi": true,
      "codex->claude": true,
    },
  };
}

async function loadExistingConfig(
  homeDir: string,
  deps: Pick<CliDeps, "readFile">,
): Promise<BridgeConfig> {
  return loadBridgeConfig(resolveConfigPath(homeDir), {
    readFile: deps.readFile ?? fs.readFile,
  });
}

async function saveBridgeConfig(
  homeDir: string,
  config: BridgeConfig,
  deps: Pick<CliDeps, "writeFile" | "mkdir">,
): Promise<string> {
  const writeFileImpl = deps.writeFile ?? fs.writeFile;
  const mkdirImpl = deps.mkdir ?? fs.mkdir;
  const configPath = resolveConfigPath(homeDir);
  await mkdirImpl(dirname(configPath), { recursive: true });
  await writeFileImpl(
    configPath,
    `${JSON.stringify(serializeBridgeConfig(config), null, 2)}\n`,
    "utf8",
  );
  return configPath;
}

function resolvePackageRoot(deps: CliDeps): string {
  if (deps.repoRoot) {
    return resolve(deps.repoRoot);
  }
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (
      existsSync(join(current, "packages", "pi", "package.json")) &&
      existsSync(join(current, "packages", "claude-code", "package.json")) &&
      existsSync(join(current, "packages", "codex", "package.json"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return resolve(process.cwd());
    }
    current = parent;
  }
}

function resolveRuntimeRoot(homeDir: string): string {
  return join(homeDir, ".agent-session-bridge", "runtime");
}

function resolveRuntimePackageDir(
  runtimeRoot: string,
  packageName: "pi" | "claude-code" | "codex",
): string {
  return join(runtimeRoot, "packages", packageName);
}

function resolveClaudeHookCliPath(runtimeRoot: string): string {
  return join(
    resolveRuntimePackageDir(runtimeRoot, "claude-code"),
    "dist",
    "claude-code",
    "src",
    "hook-cli.js",
  );
}

function resolveCodexHookCliPath(runtimeRoot: string): string {
  return join(
    resolveRuntimePackageDir(runtimeRoot, "codex"),
    "dist",
    "codex",
    "src",
    "hook-cli.js",
  );
}

function resolvePiPackagePath(runtimeRoot: string): string {
  return resolveRuntimePackageDir(runtimeRoot, "pi");
}

function hookCommandExists(entries: unknown, command: string): boolean {
  if (!Array.isArray(entries)) {
    return false;
  }
  return entries.some((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return false;
    }
    const hooks = Array.isArray((entry as { hooks?: unknown[] }).hooks)
      ? ((entry as { hooks?: unknown[] }).hooks ?? [])
      : [];
    return hooks.some(
      (hook) =>
        typeof hook === "object" &&
        hook !== null &&
        (hook as { command?: unknown }).command === command,
    );
  });
}

async function readJsonFile<T>(
  path: string,
  deps: Pick<CliDeps, "readFile">,
): Promise<T | null> {
  const readFileImpl = deps.readFile ?? fs.readFile;
  try {
    return JSON.parse(await readFileImpl(path, "utf8")) as T;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return null;
    }
    throw error;
  }
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

async function installRuntimeBundle(
  homeDir: string,
  packageRoot: string,
  deps: Pick<CliDeps, "mkdir" | "rm" | "cp" | "lstat">,
): Promise<string> {
  const runtimeRoot = resolveRuntimeRoot(homeDir);
  const mkdirImpl = deps.mkdir ?? fs.mkdir;
  const rmImpl = deps.rm ?? fs.rm;
  const cpImpl = deps.cp ?? fs.cp;

  await mkdirImpl(join(runtimeRoot, "packages"), { recursive: true });

  for (const packageName of ["pi", "claude-code", "codex"] as const) {
    const sourceDir = join(packageRoot, "packages", packageName);
    const targetDir = join(runtimeRoot, "packages", packageName);
    const sourcePackageJson = join(sourceDir, "package.json");
    const sourceDistDir = join(sourceDir, "dist");

    if (!(await pathExists(sourcePackageJson, deps))) {
      throw new Error(
        `Missing packaged asset: ${sourcePackageJson}. Run pnpm build before setup.`,
      );
    }
    if (!(await pathExists(sourceDistDir, deps))) {
      throw new Error(
        `Missing packaged asset: ${sourceDistDir}. Run pnpm build before setup.`,
      );
    }

    await rmImpl(targetDir, { force: true, recursive: true });
    await mkdirImpl(targetDir, { recursive: true });
    await cpImpl(sourcePackageJson, join(targetDir, "package.json"));
    await cpImpl(sourceDistDir, join(targetDir, "dist"), {
      recursive: true,
      force: true,
    });
  }

  return runtimeRoot;
}

function mergeHookArray(
  current: unknown,
  command: string,
  predicate?: (command: string) => boolean,
  hookConfig: Record<string, unknown> = {},
): Array<Record<string, unknown>> {
  const existing = (Array.isArray(current) ? current : [])
    .flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return [];
      }

      const hookEntries = Array.isArray((entry as { hooks?: unknown[] }).hooks)
        ? ((entry as { hooks?: unknown[] }).hooks ?? [])
        : [];

      if (hookEntries.length === 0) {
        return [entry as Record<string, unknown>];
      }

      const retainedHooks = hookEntries.filter((hook) => {
        if (typeof hook !== "object" || hook === null) {
          return true;
        }
        const hookCommand = (hook as { command?: unknown }).command;
        return !(
          typeof hookCommand === "string" && predicate?.(hookCommand) === true
        );
      });

      if (retainedHooks.length === 0) {
        return [];
      }

      return [
        {
          ...(entry as Record<string, unknown>),
          hooks: retainedHooks,
        },
      ];
    })
    .filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null,
    );
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
          ...hookConfig,
        },
      ],
    },
  ];
}

async function configureClaudeHooks(
  homeDir: string,
  runtimeRoot: string,
  deps: Pick<CliDeps, "readFile" | "writeFile" | "mkdir">,
): Promise<string> {
  const readFileImpl = deps.readFile ?? fs.readFile;
  const writeFileImpl = deps.writeFile ?? fs.writeFile;
  const mkdirImpl = deps.mkdir ?? fs.mkdir;
  const settingsPath = join(homeDir, ".claude", "settings.json");
  const hookCliPath = resolveClaudeHookCliPath(runtimeRoot);
  const isBridgeClaudeHook = (command: string): boolean =>
    command.includes("packages/claude-code") && command.includes("hook-cli.js");
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
    isBridgeClaudeHook,
    { async: true },
  );
  hooks.Stop = mergeHookArray(
    hooks.Stop,
    `node ${hookCliPath} stop`,
    isBridgeClaudeHook,
    { async: true },
  );
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
  runtimeRoot: string,
  deps: Pick<CliDeps, "writeFile" | "mkdir">,
): Promise<string> {
  const writeFileImpl = deps.writeFile ?? fs.writeFile;
  const mkdirImpl = deps.mkdir ?? fs.mkdir;
  const hooksPath = join(homeDir, ".codex", "hooks.json");
  const hookCliPath = resolveCodexHookCliPath(runtimeRoot);

  const hooks = {
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume",
          hooks: [
            {
              type: "command",
              command: `node ${hookCliPath} session-start`,
              async: true,
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
              async: true,
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
  runtimeRoot: string,
  deps: Pick<CliDeps, "readFile" | "writeFile" | "mkdir" | "rm">,
): Promise<string> {
  const readFileImpl = deps.readFile ?? fs.readFile;
  const writeFileImpl = deps.writeFile ?? fs.writeFile;
  const mkdirImpl = deps.mkdir ?? fs.mkdir;
  const rmImpl = deps.rm ?? fs.rm;
  const settingsPath = join(homeDir, ".pi", "agent", "settings.json");
  const packageSource = resolvePiPackagePath(runtimeRoot);
  const legacyExtensionPath = join(
    homeDir,
    ".pi",
    "agent",
    "extensions",
    "agent-session-bridge",
  );

  const isCurrentPackage = (value: string) => value === packageSource;
  const isStaleLocalPiPackage = (value: string) =>
    value.startsWith("/") &&
    !isCurrentPackage(value) &&
    (value.endsWith("/packages/pi") || value.endsWith("/pi"));

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
    ? settings.packages.filter(
        (value): value is string =>
          typeof value === "string" && !isStaleLocalPiPackage(value),
      )
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
  return saveBridgeConfig(
    homeDir,
    mergeEnabledProject(createDefaultConfig(), cwd, false),
    deps,
  );
}

interface ToolHealth {
  installed: boolean;
  details: string;
}

interface HookRunState {
  receivedAt?: string;
  error?: string;
}

function formatHealthLine(label: string, ok: boolean, details: string): string {
  return `${ok ? "OK" : "WARN"} ${label}: ${details}`;
}

async function readHookRunState(
  homeDir: string,
  tool: "claude-code" | "codex",
  deps: Pick<CliDeps, "readFile">,
): Promise<HookRunState> {
  const stateDir = resolveHookStateDir(homeDir, tool);
  const stop = await readJsonFile<{ receivedAt?: string }>(
    join(stateDir, "stop.json"),
    deps,
  );
  const error = await readJsonFile<{ error?: string }>(
    join(stateDir, "stop.error.json"),
    deps,
  );
  return {
    receivedAt: stop?.receivedAt,
    error: error?.error,
  };
}

async function inspectPiInstall(
  homeDir: string,
  runtimeRoot: string,
  deps: Pick<CliDeps, "readFile">,
): Promise<ToolHealth> {
  const settingsPath = join(homeDir, ".pi", "agent", "settings.json");
  const settings = await readJsonFile<{ packages?: string[] }>(
    settingsPath,
    deps,
  );
  const expected = resolvePiPackagePath(runtimeRoot);
  const installed = Boolean(settings?.packages?.includes(expected));
  return {
    installed,
    details: installed
      ? `package registered in ${settingsPath}`
      : `missing package registration in ${settingsPath}`,
  };
}

async function inspectClaudeInstall(
  homeDir: string,
  runtimeRoot: string,
  deps: Pick<CliDeps, "readFile">,
): Promise<ToolHealth> {
  const settingsPath = join(homeDir, ".claude", "settings.json");
  const settings = await readJsonFile<Record<string, unknown>>(
    settingsPath,
    deps,
  );
  const hooks =
    typeof settings?.hooks === "object" && settings?.hooks !== null
      ? (settings.hooks as Record<string, unknown>)
      : {};
  const hookCliPath = resolveClaudeHookCliPath(runtimeRoot);
  const startInstalled = hookCommandExists(
    hooks.SessionStart,
    `node ${hookCliPath} session-start`,
  );
  const stopInstalled = hookCommandExists(
    hooks.Stop,
    `node ${hookCliPath} stop`,
  );
  return {
    installed: startInstalled && stopInstalled,
    details:
      startInstalled && stopInstalled
        ? `hooks registered in ${settingsPath}`
        : `missing bridge hooks in ${settingsPath}`,
  };
}

async function inspectCodexInstall(
  homeDir: string,
  runtimeRoot: string,
  deps: Pick<CliDeps, "readFile">,
): Promise<ToolHealth> {
  const hooksPath = join(homeDir, ".codex", "hooks.json");
  const hooksFile = await readJsonFile<Record<string, unknown>>(
    hooksPath,
    deps,
  );
  const hooks =
    typeof hooksFile?.hooks === "object" && hooksFile?.hooks !== null
      ? (hooksFile.hooks as Record<string, unknown>)
      : {};
  const hookCliPath = resolveCodexHookCliPath(runtimeRoot);
  const startInstalled = hookCommandExists(
    hooks.SessionStart,
    `node ${hookCliPath} session-start`,
  );
  const stopInstalled = hookCommandExists(
    hooks.Stop,
    `node ${hookCliPath} stop`,
  );
  return {
    installed: startInstalled && stopInstalled,
    details:
      startInstalled && stopInstalled
        ? `hooks registered in ${hooksPath}`
        : `missing bridge hooks in ${hooksPath}`,
  };
}

function zeroUsageCost(): Record<string, unknown> {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  };
}

function normalizeUsageValue(value: unknown): Record<string, unknown> {
  const source =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};

  const numberAt = (...keys: string[]): number => {
    for (const key of keys) {
      const candidate = source[key];
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        return candidate;
      }
    }
    return 0;
  };

  const costSource =
    typeof source.cost === "object" && source.cost !== null
      ? (source.cost as Record<string, unknown>)
      : {};
  const numberInCost = (key: string): number =>
    typeof costSource[key] === "number" &&
    Number.isFinite(costSource[key] as number)
      ? (costSource[key] as number)
      : 0;

  const input = numberAt("input", "input_tokens");
  const output = numberAt("output", "output_tokens");
  const cacheRead = numberAt("cacheRead", "cache_read_input_tokens");
  const cacheWrite = numberAt("cacheWrite", "cache_creation_input_tokens");
  const totalTokens =
    numberAt("totalTokens", "total_tokens") ||
    input + output + cacheRead + cacheWrite;

  return {
    ...source,
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: {
      ...zeroUsageCost(),
      input: numberInCost("input"),
      output: numberInCost("output"),
      cacheRead: numberInCost("cacheRead"),
      cacheWrite: numberInCost("cacheWrite"),
      total: numberInCost("total"),
    },
  };
}

const directiveLinePattern =
  /^::(?:git-[a-z-]+|automation-update|code-comment|archive)\{[^]*\}$/;

function sanitizeTextBlock(text: string): string {
  const stripped = text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return true;
      }
      return !directiveLinePattern.test(trimmed);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  try {
    const parsed = JSON.parse(stripped) as Record<string, unknown>;
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed.type === "input_text" || parsed.type === "output_text") &&
      typeof parsed.text === "string"
    ) {
      return parsed.text;
    }
  } catch {}

  return stripped;
}

const metaPrefixes = [
  "<permissions instructions>",
  "<app-context>",
  "<collaboration_mode>",
  "<apps_instructions>",
  "<skills_instructions>",
  "<plugins_instructions>",
  "# AGENTS.md instructions for ",
  "<environment_context>",
  "<turn_aborted>",
  "When you write or edit a git commit message, ensure the message ends with this trailer exactly once:",
];

function sanitizeMessageContent(content: unknown): {
  nextContent: unknown;
  textParts: string[];
  touched: boolean;
} {
  if (typeof content === "string") {
    const sanitized = sanitizeTextBlock(content);
    return {
      nextContent: sanitized,
      textParts: sanitized ? [sanitized] : [],
      touched: sanitized !== content,
    };
  }

  if (!Array.isArray(content)) {
    return { nextContent: content, textParts: [], touched: false };
  }

  let touched = false;
  const nextItems = content.flatMap((item) => {
    if (typeof item !== "object" || item === null) {
      return [item];
    }
    const record = item as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      const raw = record.text;
      if (raw.trim() === "<image>" || raw.trim() === "</image>") {
        touched = true;
        return [];
      }
      const sanitized = sanitizeTextBlock(raw);
      if (!sanitized) {
        touched = true;
        return [];
      }
      if (sanitized !== raw) {
        touched = true;
      }
      return [{ ...record, text: sanitized }];
    }
    return [item];
  });

  const textParts = nextItems.flatMap((item) =>
    typeof item === "object" &&
    item !== null &&
    (item as { type?: unknown }).type === "text" &&
    typeof (item as { text?: unknown }).text === "string"
      ? [(item as { text: string }).text]
      : [],
  );
  return {
    nextContent: nextItems,
    textParts,
    touched,
  };
}

function isMetaTextParts(parts: string[]): boolean {
  if (parts.length === 0) {
    return false;
  }
  const joined = parts.join("\n").trimStart();
  return metaPrefixes.some((prefix) => joined.startsWith(prefix));
}

async function repairPiSessionsForProject(
  cwd: string,
  homeDir: string,
  deps: Pick<CliDeps, "readFile" | "writeFile" | "mkdir" | "lstat">,
): Promise<{
  filesTouched: number;
  filesScanned: number;
  entriesRemoved: number;
  assistantEntriesPatched: number;
}> {
  const dir = getPiSessionDir(cwd, homeDir);
  if (!(await pathExists(dir, deps))) {
    return {
      filesTouched: 0,
      filesScanned: 0,
      entriesRemoved: 0,
      assistantEntriesPatched: 0,
    };
  }

  const files = (await fs.readdir(dir))
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  let filesTouched = 0;
  let entriesRemoved = 0;
  let assistantEntriesPatched = 0;

  for (const name of files) {
    const path = join(dir, name);
    const raw = await (deps.readFile ?? fs.readFile)(path, "utf8");
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    if (lines.length === 0) {
      continue;
    }
    const [header, ...rest] = lines;
    let fileTouched = false;
    const sanitizedEntries = rest.map((entry) => {
      if (entry.type !== "message") {
        return entry;
      }
      const message =
        typeof entry.message === "object" && entry.message !== null
          ? ({ ...(entry.message as Record<string, unknown>) } satisfies Record<
              string,
              unknown
            >)
          : undefined;
      if (!message) {
        return entry;
      }
      const { nextContent, textParts, touched } = sanitizeMessageContent(
        message.content,
      );
      if (touched) {
        fileTouched = true;
      }
      const nextMessage: Record<string, unknown> = {
        ...message,
        content: nextContent,
      };
      const nextEntry: Record<string, unknown> = {
        ...entry,
        message: nextMessage,
      };
      if (message.role === "assistant") {
        const nextUsage = normalizeUsageValue(message.usage);
        if (JSON.stringify(nextUsage) !== JSON.stringify(message.usage ?? {})) {
          assistantEntriesPatched += 1;
          fileTouched = true;
        }
        nextEntry.message = {
          ...(nextEntry.message as Record<string, unknown>),
          usage: nextUsage,
          provider:
            typeof message.provider === "string"
              ? message.provider
              : "openai-codex",
          model: typeof message.model === "string" ? message.model : "gpt-5.4",
        };
      }
      return {
        ...nextEntry,
        __userTextParts: Array.isArray(textParts) ? textParts : [],
      } as Record<string, unknown>;
    });

    let firstMeaningfulIndex = -1;
    for (let index = 0; index < sanitizedEntries.length; index += 1) {
      const entry = sanitizedEntries[index]!;
      const message =
        typeof entry.message === "object" && entry.message !== null
          ? (entry.message as Record<string, unknown>)
          : null;
      if (message?.role !== "user") {
        continue;
      }
      const parts = Array.isArray(entry.__userTextParts)
        ? (entry.__userTextParts as string[])
            .map((part) => part.trim())
            .filter(Boolean)
        : [];
      if (parts.length > 0 && !isMetaTextParts(parts)) {
        firstMeaningfulIndex = index;
        break;
      }
    }

    const keptEntries = sanitizedEntries.filter((entry, index) => {
      const message =
        typeof entry.message === "object" && entry.message !== null
          ? (entry.message as Record<string, unknown>)
          : null;
      if (message?.role !== "user") {
        return true;
      }
      const parts = Array.isArray(entry.__userTextParts)
        ? (entry.__userTextParts as string[])
            .map((part) => part.trim())
            .filter(Boolean)
        : [];
      const beforeMeaningful =
        firstMeaningfulIndex === -1 || index < firstMeaningfulIndex;
      const metaOrEmpty = parts.length === 0 || isMetaTextParts(parts);
      if (beforeMeaningful && metaOrEmpty) {
        entriesRemoved += 1;
        fileTouched = true;
        return false;
      }
      return true;
    });

    let previousId: string | null = null;
    for (const entry of keptEntries) {
      delete entry.__userTextParts;
      if (entry.type === "message") {
        const nextParent = previousId;
        if (entry.parentId !== nextParent) {
          fileTouched = true;
          entry.parentId = nextParent;
        }
        previousId = typeof entry.id === "string" ? entry.id : previousId;
      }
    }

    if (!fileTouched) {
      continue;
    }

    filesTouched += 1;
    await (deps.mkdir ?? fs.mkdir)(dirname(path), { recursive: true });
    await (deps.writeFile ?? fs.writeFile)(
      path,
      `${[header, ...keptEntries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
  }

  return {
    filesTouched,
    filesScanned: files.length,
    entriesRemoved,
    assistantEntriesPatched,
  };
}

async function repairClaudeSessionsForProject(
  cwd: string,
  homeDir: string,
  deps: Pick<CliDeps, "readFile" | "writeFile" | "mkdir" | "lstat">,
): Promise<{
  filesTouched: number;
  filesScanned: number;
  thinkingBlocksRemoved: number;
}> {
  const dir = getClaudeCodeProjectDir(cwd, homeDir);
  if (!(await pathExists(dir, deps))) {
    return {
      filesTouched: 0,
      filesScanned: 0,
      thinkingBlocksRemoved: 0,
    };
  }

  const files = (await fs.readdir(dir))
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  let filesTouched = 0;
  let thinkingBlocksRemoved = 0;

  for (const name of files) {
    const path = join(dir, name);
    const raw = await (deps.readFile ?? fs.readFile)(path, "utf8");
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    let fileTouched = false;

    const sanitizedLines = lines.map((line) => {
      if (
        line.type !== "assistant" ||
        typeof line.message !== "object" ||
        line.message === null
      ) {
        return line;
      }

      const message = {
        ...(line.message as Record<string, unknown>),
      } satisfies Record<string, unknown>;

      if (!Array.isArray(message.content)) {
        return line;
      }

      const nextContent = message.content.filter((item) => {
        if (
          typeof item === "object" &&
          item !== null &&
          (item as { type?: unknown }).type === "thinking"
        ) {
          const thinkingValue = (item as { thinking?: unknown }).thinking;
          if (
            typeof thinkingValue !== "string" ||
            thinkingValue.trim().length === 0
          ) {
            thinkingBlocksRemoved += 1;
            fileTouched = true;
            return false;
          }
          if ("signature" in (item as Record<string, unknown>)) {
            delete (item as Record<string, unknown>).signature;
            fileTouched = true;
          }
        }
        return true;
      });

      if (!fileTouched) {
        return line;
      }

      return {
        ...line,
        message: {
          ...message,
          content: nextContent,
        },
      };
    });

    if (!fileTouched) {
      continue;
    }

    filesTouched += 1;
    await (deps.mkdir ?? fs.mkdir)(dirname(path), { recursive: true });
    await (deps.writeFile ?? fs.writeFile)(
      path,
      `${sanitizedLines.map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );
  }

  return {
    filesTouched,
    filesScanned: files.length,
    thinkingBlocksRemoved,
  };
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...restWithFlags] = argv;
  const rest = withoutFlags(restWithFlags);
  const dryRun = hasFlag(restWithFlags, "--dry-run");
  const globalMode = hasFlag(restWithFlags, "--global");
  const importMode = hasFlag(restWithFlags, "--all") ? "--all" : "--latest";
  const registry = await deps.load();
  const homeDir = resolveHomeDir(deps);
  const cwd = resolveCwd(deps, restWithFlags);
  const packageRoot = resolvePackageRoot(deps);
  const runtimeRoot = resolveRuntimeRoot(homeDir);
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
    const nextConfig = mergeEnabledProject(
      await loadExistingConfig(homeDir, deps),
      cwd,
      globalMode,
    );
    if (!dryRun) {
      await installRuntimeBundle(homeDir, packageRoot, deps);
      await saveBridgeConfig(homeDir, nextConfig, deps);
      await configureClaudeHooks(homeDir, runtimeRoot, deps);
      await configureCodexHooks(homeDir, runtimeRoot, deps);
      await configurePiExtension(homeDir, runtimeRoot, deps);
    }

    deps.stdout(
      `Agent Session Bridge setup ${dryRun ? "(dry-run) " : ""}complete.`,
    );
    deps.stdout(`Project scope: ${globalMode ? "global" : cwd}`);
    deps.stdout(`Config: ${resolveConfigPath(homeDir)}`);
    deps.stdout(`Runtime: ${runtimeRoot}`);
    deps.stdout(`Pi: ${join(homeDir, ".pi", "agent", "settings.json")}`);
    deps.stdout(`Claude Code: ${join(homeDir, ".claude", "settings.json")}`);
    deps.stdout(`Codex: ${join(homeDir, ".codex", "hooks.json")}`);
    deps.stdout(
      "Next steps: restart Pi, Claude Code, and Codex so they reload their integration settings.",
    );
    return 0;
  }

  if (command === "enable") {
    const nextConfig = mergeEnabledProject(
      await loadExistingConfig(homeDir, deps),
      cwd,
      globalMode,
    );
    if (!dryRun) {
      await saveBridgeConfig(homeDir, nextConfig, deps);
    }
    deps.stdout(
      `Bridge sync ${dryRun ? "would be enabled" : "enabled"} for ${
        globalMode ? "all projects" : cwd
      }.`,
    );
    deps.stdout(`Config: ${resolveConfigPath(homeDir)}`);
    return 0;
  }

  if (command === "doctor") {
    const config = await loadExistingConfig(homeDir, deps);
    const pi = await inspectPiInstall(homeDir, runtimeRoot, deps);
    const claude = await inspectClaudeInstall(homeDir, runtimeRoot, deps);
    const codex = await inspectCodexInstall(homeDir, runtimeRoot, deps);
    const claudeState = await readHookRunState(homeDir, "claude-code", deps);
    const codexState = await readHookRunState(homeDir, "codex", deps);
    const conversations = registry.conversations.filter(
      (conversation) =>
        conversation.projectKey === cwd || conversation.canonicalCwd === cwd,
    );
    const projectEnabled = isProjectEnabled(config, cwd);

    deps.stdout(`Doctor report for ${cwd}`);
    deps.stdout(
      formatHealthLine(
        "config",
        config.optIn,
        config.optIn ? "opt-in enabled" : "opt-in disabled",
      ),
    );
    deps.stdout(
      formatHealthLine(
        "project",
        projectEnabled,
        projectEnabled
          ? config.enabledProjects.length === 0
            ? "sync enabled globally"
            : "sync enabled for this project"
          : "project not enabled for sync",
      ),
    );
    deps.stdout(formatHealthLine("pi", pi.installed, pi.details));
    deps.stdout(formatHealthLine("claude", claude.installed, claude.details));
    deps.stdout(formatHealthLine("codex", codex.installed, codex.details));
    deps.stdout(
      formatHealthLine(
        "claude sync",
        Boolean(claudeState.receivedAt) && !claudeState.error,
        claudeState.error
          ? `last hook error: ${claudeState.error}`
          : claudeState.receivedAt
            ? `last stop hook: ${claudeState.receivedAt}`
            : "no stop hook run recorded yet",
      ),
    );
    deps.stdout(
      formatHealthLine(
        "codex sync",
        Boolean(codexState.receivedAt) && !codexState.error,
        codexState.error
          ? `last hook error: ${codexState.error}`
          : codexState.receivedAt
            ? `last stop hook: ${codexState.receivedAt}`
            : "no stop hook run recorded yet",
      ),
    );
    deps.stdout(
      `Registry: ${conversations.length} conversation${conversations.length === 1 ? "" : "s"} linked to this project.`,
    );
    return pi.installed && claude.installed && codex.installed && projectEnabled
      ? 0
      : 1;
  }

  if (command === "repair") {
    const [bridgeSessionId] = rest;
    let conversation = bridgeSessionId
      ? findConversationByBridgeSessionId(registry, bridgeSessionId)
      : undefined;
    if (!conversation) {
      conversation = findConversationByProjectKey(registry, cwd);
    }

    if (!dryRun) {
      const piSummary = await repairPiSessionsForProject(cwd, homeDir, deps);
      const claudeSummary = await repairClaudeSessionsForProject(
        cwd,
        homeDir,
        deps,
      );
      if (conversation) {
        const updated = upsertConversation(
          registry,
          setRepairState(conversation, {
            status: "idle",
            reason:
              piSummary.filesTouched > 0 || claudeSummary.filesTouched > 0
                ? `repaired ${piSummary.filesTouched} Pi and ${claudeSummary.filesTouched} Claude session files`
                : "repair scan found nothing to change",
            updatedAt: new Date().toISOString(),
          }),
        );
        await deps.save(updated);
      }
      deps.stdout(
        `repair complete: scanned ${piSummary.filesScanned} Pi session files and ${claudeSummary.filesScanned} Claude session files, touched ${piSummary.filesTouched} Pi and ${claudeSummary.filesTouched} Claude, removed ${piSummary.entriesRemoved} bad Pi title entries, patched ${piSummary.assistantEntriesPatched} Pi assistant messages, removed ${claudeSummary.thinkingBlocksRemoved} empty Claude thinking blocks`,
      );
      return 0;
    }

    deps.stdout(`repair would scan Pi and Claude sessions for ${cwd}`);
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

export async function main(): Promise<number> {
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

export function isCliEntrypoint(
  argv1: string | undefined,
  moduleUrl: string = import.meta.url,
): boolean {
  if (argv1 == null) {
    return false;
  }

  const modulePath = fileURLToPath(moduleUrl);
  if (modulePath === argv1) {
    return true;
  }

  try {
    return realpathSync(modulePath) === realpathSync(argv1);
  } catch {
    return false;
  }
}

const isMain = isCliEntrypoint(process.argv[1], import.meta.url);

if (isMain) {
  main().then((code) => {
    process.exitCode = code;
  });
}
