import type { ToolName } from "./types.js";

export interface BridgeConfig {
  optIn: boolean;
  enabledProjects: string[];
  disabledProjects: string[];
  directions: Record<`${ToolName}->${ToolName}`, boolean>;
  redactionPatterns: RegExp[];
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
  if (!config.optIn) {
    return false;
  }
  if (config.disabledProjects.includes(projectKey)) {
    return false;
  }
  if (config.enabledProjects.length === 0) {
    return true;
  }
  return config.enabledProjects.includes(projectKey);
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
