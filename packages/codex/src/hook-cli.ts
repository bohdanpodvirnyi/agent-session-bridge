#!/usr/bin/env node

import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseCodexHookPayload,
  runCodexSessionStart,
  runCodexStop,
} from "./index.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runHook(
  argv: string[] = process.argv.slice(2),
  rawInput?: string,
): Promise<number> {
  const [event = "stop"] = argv;
  const stateDir = join(homedir(), ".agent-session-bridge", "codex-hooks");
  const receivedAt = new Date().toISOString();

  try {
    const raw = rawInput ?? (await readStdin());
    const payload = raw.trim() ? parseCodexHookPayload(raw) : {};
    const result =
      event === "session-start"
        ? await runCodexSessionStart(payload)
        : await runCodexStop(payload);

    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      join(stateDir, `${event}.json`),
      JSON.stringify(
        {
          event,
          receivedAt,
          payload,
          result,
        },
        null,
        2,
      ),
      "utf8",
    );
    return 0;
  } catch (error) {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      join(stateDir, `${event}.error.json`),
      JSON.stringify(
        {
          event,
          receivedAt,
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
      "utf8",
    );
    // Never block Codex from continuing because of bridge hook issues.
    return 0;
  }
}

const isMain =
  process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  runHook().then((code) => {
    process.exitCode = code;
  });
}
