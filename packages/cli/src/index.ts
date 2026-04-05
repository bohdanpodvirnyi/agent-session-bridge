#!/usr/bin/env node

import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  createDefaultConfig,
  findConversationByBridgeSessionId,
  findConversationByProjectKey,
  loadRegistry,
  saveRegistry,
  setRepairState,
  upsertConversation,
  type BridgeRegistry,
} from "agent-session-bridge-core";

export interface CliDeps {
  load(): Promise<BridgeRegistry>;
  save(registry: BridgeRegistry): Promise<void>;
  stdout(line: string): void;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function withoutFlags(args: string[]): string[] {
  return args.filter((arg) => !arg.startsWith("--"));
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...restWithFlags] = argv;
  const rest = withoutFlags(restWithFlags);
  const dryRun = hasFlag(restWithFlags, "--dry-run");
  const importMode = hasFlag(restWithFlags, "--all")
    ? "--all"
    : (rest[0] ?? "--latest");
  const registry = await deps.load();

  if (!command || command === "list") {
    for (const conversation of registry.conversations) {
      deps.stdout(
        `${conversation.bridgeSessionId} ${conversation.projectKey} ${conversation.status}`,
      );
    }
    return 0;
  }

  if (command === "setup") {
    deps.stdout(
      `agent-session-bridge setup complete (opt-in=${createDefaultConfig().optIn})`,
    );
    return 0;
  }

  if (command === "import") {
    deps.stdout(`import mode: ${importMode}${dryRun ? " (dry-run)" : ""}`);
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
  const registryPath = join(
    homedir(),
    ".agent-session-bridge",
    "registry.json",
  );

  return runCli(process.argv.slice(2), {
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
    stdout: (line) => {
      console.log(line);
    },
  });
}

main().then((code) => {
  process.exitCode = code;
});
