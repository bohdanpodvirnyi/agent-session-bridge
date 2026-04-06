import { homedir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import {
  handleMessageEnd,
  restorePiBridgeState,
  runPiMessageSync,
  runPiSessionImport,
  serializePiBridgeState,
  type PiBridgeState,
} from "./src/index.js";

const CUSTOM_TYPE = "agent-session-bridge-state";

function isMissingSessionFileError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const nodeError = error as NodeJS.ErrnoException;
  return (
    nodeError.code === "ENOENT" ||
    error.message.includes("ENOENT: no such file or directory")
  );
}

function canUseUi(ctx: ExtensionContext): boolean {
  return Boolean(ctx.hasUI);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseState(value: unknown): PiBridgeState | null {
  if (typeof value === "string") {
    try {
      return restorePiBridgeState(value);
    } catch {
      return null;
    }
  }

  if (
    isRecord(value) &&
    typeof value.mirrorSessionId === "string" &&
    typeof value.mirrorPath === "string" &&
    typeof value.updatedAt === "string"
  ) {
    return value as PiBridgeState;
  }

  return null;
}

function loadState(ctx: ExtensionContext): PiBridgeState | null {
  let current: PiBridgeState | null = null;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
    current = parseState(entry.data) ?? current;
  }
  return current;
}

function persistState(
  pi: { appendEntry: (customType: string, data?: unknown) => void },
  state: PiBridgeState,
) {
  pi.appendEntry(CUSTOM_TYPE, serializePiBridgeState(state));
}

export default function agentSessionBridge(pi: ExtensionAPI) {
  let state: PiBridgeState | null = null;
  const homeDir = homedir();
  const registryPath = join(homeDir, ".agent-session-bridge", "registry.json");

  const updateStatus = (_ctx: ExtensionContext) => {};

  const reload = (ctx: ExtensionContext) => {
    state = loadState(ctx);
    updateStatus(ctx);
  };

  const saveTrackedMirror = (
    ctx: ExtensionContext,
    mirrorSessionId: string,
    mirrorPath: string,
  ) => {
    state = {
      mirrorSessionId,
      mirrorPath,
      updatedAt: new Date().toISOString(),
    };
    persistState(pi, state);
    updateStatus(ctx);
  };

  const refreshImports = async (ctx: ExtensionContext) => {
    reload(ctx);

    try {
      const imported = await runPiSessionImport(ctx.cwd, {
        homeDir,
        registryPath,
      });

      const claudeMirror = imported.result?.conversation.mirrors.claude;
      if (claudeMirror) {
        saveTrackedMirror(ctx, claudeMirror.nativeId, claudeMirror.sessionPath);
      }
    } catch (error) {
      if (canUseUi(ctx)) {
        ctx.ui.notify(
          `agent-session-bridge import failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "warning",
        );
      }
    }
  };

  const syncCurrentSession = async (ctx: ExtensionContext) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionFile || !sessionId) {
      return;
    }

    const result = await runPiMessageSync(sessionFile, sessionId, {
      homeDir,
      registryPath,
      cwd: ctx.cwd,
    });

    const claudeMirror = result.conversation.mirrors.claude;
    if (claudeMirror) {
      saveTrackedMirror(ctx, claudeMirror.nativeId, claudeMirror.sessionPath);
    } else if (state) {
      state = {
        ...state,
        updatedAt: new Date().toISOString(),
      };
      persistState(pi, state);
    }
    updateStatus(ctx);
  };

  pi.on("session_start", async (_event, ctx) => refreshImports(ctx));
  pi.on("session_switch", async (_event, ctx) => refreshImports(ctx));
  pi.on("session_fork", async (_event, ctx) => refreshImports(ctx));
  pi.on("session_tree", async (_event, ctx) => refreshImports(ctx));

  pi.on("message_end", async (event, ctx) => {
    try {
      const entry =
        typeof event === "object" &&
        event !== null &&
        "message" in event &&
        event.message
          ? event.message
          : event;

      handleMessageEnd(entry as never);
      await syncCurrentSession(ctx);
    } catch (error) {
      if (isMissingSessionFileError(error)) {
        return;
      }
      if (canUseUi(ctx)) {
        ctx.ui.notify(
          `agent-session-bridge: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "warning",
        );
      }
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    try {
      await syncCurrentSession(ctx);
    } catch (error) {
      if (isMissingSessionFileError(error)) {
        return;
      }
      if (canUseUi(ctx)) {
        ctx.ui.notify(
          `agent-session-bridge: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "warning",
        );
      }
    }
  });

  pi.registerCommand("bridge-status", {
    description:
      "Show Agent Session Bridge install status for this Pi session.",
    handler: async (_args, ctx) => {
      if (state) {
        ctx.ui.notify(
          `bridge mirror: ${state.mirrorSessionId} -> ${state.mirrorPath}`,
          "info",
        );
        return;
      }

      ctx.ui.notify(
        "Agent Session Bridge is installed, but no mirror is tracked for this session yet.",
        "info",
      );
    },
  });

  pi.registerCommand("bridge-track", {
    description:
      "Track a mirror session for this Pi session. Usage: /bridge-track <mirrorSessionId> <mirrorPath>",
    handler: async (args, ctx) => {
      const [mirrorSessionId, ...pathParts] = args.trim().split(/\s+/);
      const mirrorPath = pathParts.join(" ").trim();

      if (!mirrorSessionId || !mirrorPath) {
        ctx.ui.notify(
          "usage: /bridge-track <mirrorSessionId> <mirrorPath>",
          "warning",
        );
        return;
      }

      saveTrackedMirror(ctx, mirrorSessionId, mirrorPath);
      ctx.ui.notify(`tracking mirror ${mirrorSessionId}`, "info");
    },
  });
}
