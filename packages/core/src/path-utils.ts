import { join } from "node:path";

import type { PathAccessLike, RepoDetector } from "./types.js";

export function normalizePath(path: string): string {
  const replaced = path.replace(/\\/g, "/").replace(/\/+$/u, "");
  return replaced || "/";
}

export function dirname(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

export async function deriveProjectKey(
  cwd: string,
  deps: { realpath(path: string): Promise<string> } & RepoDetector,
): Promise<{ canonicalCwd: string; projectKey: string }> {
  const canonicalCwd = normalizePath(await deps.realpath(cwd));
  const repoRoot = await deps.findRepoRoot(canonicalCwd);
  return {
    canonicalCwd,
    projectKey: normalizePath(repoRoot ?? canonicalCwd),
  };
}

export async function findGitRepoRoot(
  cwd: string,
  deps: PathAccessLike,
): Promise<string | null> {
  let current = normalizePath(cwd);

  while (true) {
    if (await deps.exists(join(current, ".git"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function encodeCwdForPi(cwd: string): string {
  const trimmed = normalizePath(cwd).replace(/^\/+/u, "");
  return `--${trimmed.replace(/[/:\\]/g, "-")}--`;
}

export function encodeCwdForClaudeCode(cwd: string): string {
  return normalizePath(cwd).replace(/[^a-z0-9]/giu, "-");
}

export function getPiSessionDir(cwd: string, homeDir: string): string {
  return join(homeDir, ".pi", "agent", "sessions", encodeCwdForPi(cwd));
}

export function getClaudeCodeProjectDir(cwd: string, homeDir: string): string {
  return join(homeDir, ".claude", "projects", encodeCwdForClaudeCode(cwd));
}

export function getCodexSessionDir(date: Date, homeDir: string): string {
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return join(homeDir, ".codex", "sessions", year, month, day);
}
