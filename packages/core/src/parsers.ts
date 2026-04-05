import { readFile } from "node:fs/promises";
import { zstdDecompressSync } from "node:zlib";

import type {
  ClaudeCodeLine,
  CodexRolloutItem,
  PiSession,
  PiSessionEntry,
  PiSessionHeader,
} from "./types.js";

function parseJsonLines(content: string): unknown[] {
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export async function readPiSession(path: string): Promise<PiSession> {
  const content = await readFile(path, "utf8");
  const lines = parseJsonLines(content);
  const [header, ...entries] = lines as [PiSessionHeader, ...PiSessionEntry[]];

  if (!header || header.type !== "session") {
    throw new Error("Invalid Pi session");
  }

  return {
    header,
    entries,
  };
}

export async function readClaudeCodeSession(
  path: string,
): Promise<ClaudeCodeLine[]> {
  const content = await readFile(path, "utf8");
  return parseJsonLines(content) as ClaudeCodeLine[];
}

export async function readCodexRollout(
  path: string,
): Promise<CodexRolloutItem[]> {
  const raw = await readFile(path);
  const content = path.endsWith(".zst")
    ? zstdDecompressSync(raw).toString("utf8")
    : raw.toString("utf8");
  return parseJsonLines(content) as CodexRolloutItem[];
}

export function flattenPiActiveBranch(session: PiSession): PiSessionEntry[] {
  const byId = new Map<string, PiSessionEntry>();
  let latest: PiSessionEntry | undefined;

  for (const entry of session.entries) {
    if (entry.id) {
      byId.set(entry.id, entry);
      latest = entry;
    }
  }

  if (!latest?.id) {
    return session.entries;
  }

  const branch: PiSessionEntry[] = [];
  let current: PiSessionEntry | undefined = latest;

  while (current) {
    branch.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return branch.reverse();
}

export function extractMessageEntries(
  entries: PiSessionEntry[],
): PiSessionEntry[] {
  return entries.filter(
    (entry) => entry.type === "message" && typeof entry.message === "object",
  );
}
