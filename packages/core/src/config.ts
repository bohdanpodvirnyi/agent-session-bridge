import { normalizePath } from "./path-utils.js";
import type { ToolName } from "./types.js";

export interface BridgeConfig {
  optIn: boolean;
  enabledProjects: string[];
  disabledProjects: string[];
  directions: Record<`${ToolName}->${ToolName}`, boolean>;
  redactionPatterns: RegExp[];
}

export interface SerializedBridgeConfig {
  optIn: boolean;
  enabledProjects: string[];
  disabledProjects: string[];
  directions: Record<`${ToolName}->${ToolName}`, boolean>;
  redactionPatterns: Array<{
    source: string;
    flags: string;
  }>;
}

export function createDefaultConfig(): BridgeConfig {
  return {
    optIn: false,
    enabledProjects: [],
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
    redactionPatterns: [/sk-[a-z0-9]+/giu, /api[_-]?key\s*[:=]\s*\S+/giu],
  };
}

export function isProjectEnabled(
  config: BridgeConfig,
  projectKey: string,
): boolean {
  const normalizedProject = normalizePath(projectKey);
  const matchesScope = (candidate: string): boolean => {
    const normalizedCandidate = normalizePath(candidate);
    return (
      normalizedProject === normalizedCandidate ||
      normalizedProject.startsWith(`${normalizedCandidate}/`)
    );
  };

  if (!config.optIn) {
    return false;
  }
  if (config.disabledProjects.some(matchesScope)) {
    return false;
  }
  if (config.enabledProjects.length === 0) {
    return true;
  }
  return config.enabledProjects.some(matchesScope);
}

export function shouldSyncDirection(
  config: BridgeConfig,
  sourceTool: ToolName,
  targetTool: ToolName,
): boolean {
  return Boolean(config.directions[`${sourceTool}->${targetTool}`]);
}

export function redactSecrets(content: string, patterns: RegExp[]): string {
  return patterns.reduce(
    (value, pattern) => value.replace(pattern, "[REDACTED]"),
    content,
  );
}

export function serializeBridgeConfig(
  config: BridgeConfig,
): SerializedBridgeConfig {
  return {
    ...config,
    redactionPatterns: config.redactionPatterns.map((pattern) => ({
      source: pattern.source,
      flags: pattern.flags,
    })),
  };
}

export function deserializeBridgeConfig(
  value: SerializedBridgeConfig,
): BridgeConfig {
  return {
    ...value,
    redactionPatterns: value.redactionPatterns.map(
      (pattern) => new RegExp(pattern.source, pattern.flags),
    ),
  };
}

export async function loadBridgeConfig(
  configPath: string,
  fs: { readFile(path: string, encoding: BufferEncoding): Promise<string> },
): Promise<BridgeConfig> {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return deserializeBridgeConfig(JSON.parse(raw) as SerializedBridgeConfig);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return createDefaultConfig();
    }
    throw error;
  }
}
