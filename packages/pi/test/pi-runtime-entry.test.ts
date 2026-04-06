import { beforeEach, describe, expect, it, vi } from "vitest";

const runPiSessionImport = vi.fn();
const runPiMessageSync = vi.fn();

vi.mock("../src/index.js", () => ({
  handleMessageEnd: <T>(entry: T) => entry,
  restorePiBridgeState: (raw: string) => JSON.parse(raw),
  runPiMessageSync,
  runPiSessionImport,
  serializePiBridgeState: (state: unknown) => JSON.stringify(state),
}));

describe("pi runtime entry", () => {
  beforeEach(() => {
    vi.resetModules();
    runPiSessionImport.mockReset();
    runPiMessageSync.mockReset();
  });

  it("syncs in headless sessions without calling UI helpers", async () => {
    runPiSessionImport.mockResolvedValue({ imported: false });
    runPiMessageSync.mockResolvedValue({
      conversation: {
        bridgeSessionId: "bridge-1",
        projectKey: "/repo/demo",
        canonicalCwd: "/repo/demo",
        createdAt: "2026-04-05T10:00:00.000Z",
        updatedAt: "2026-04-05T10:00:00.000Z",
        status: "active",
        mirrors: {
          claude: {
            nativeId: "claude-1",
            sessionPath: "/tmp/claude-1.jsonl",
          },
        },
        lastWrittenOffsets: [],
      },
      writes: [],
    });

    const { default: agentSessionBridge } = await import("../index.ts");
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
    const appendEntry = vi.fn();

    agentSessionBridge({
      appendEntry,
      on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
        handlers.set(event, handler);
      },
      registerCommand() {},
    } as never);

    const ctx = {
      cwd: "/repo/demo",
      hasUI: false,
      ui: {
        setStatus() {
          throw new Error("setStatus should not be called in headless mode");
        },
        notify() {
          throw new Error("notify should not be called in headless mode");
        },
      },
      sessionManager: {
        getBranch() {
          return [];
        },
        getSessionFile() {
          return "/tmp/pi-session.jsonl";
        },
        getSessionId() {
          return "pi-session-1";
        },
      },
    };

    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("message_end")?.({ message: { id: "entry-1" } }, ctx);

    expect(runPiSessionImport).toHaveBeenCalledOnce();
    expect(runPiMessageSync).toHaveBeenCalledOnce();
    expect(appendEntry).toHaveBeenCalledOnce();
    expect(appendEntry.mock.calls[0]?.[0]).toBe("agent-session-bridge-state");
  });

  it("suppresses missing-session warnings and retries sync on turn_end", async () => {
    runPiSessionImport.mockResolvedValue({ imported: false });
    const enoent = Object.assign(
      new Error("ENOENT: no such file or directory, stat '/tmp/pi-session.jsonl'"),
      { code: "ENOENT" },
    );
    runPiMessageSync
      .mockRejectedValueOnce(enoent)
      .mockResolvedValueOnce({
        conversation: {
          bridgeSessionId: "bridge-1",
          projectKey: "/repo/demo",
          canonicalCwd: "/repo/demo",
          createdAt: "2026-04-05T10:00:00.000Z",
          updatedAt: "2026-04-05T10:00:00.000Z",
          status: "active",
          mirrors: {
            claude: {
              nativeId: "claude-1",
              sessionPath: "/tmp/claude-1.jsonl",
            },
          },
          lastWrittenOffsets: [],
        },
        writes: [],
      });

    const { default: agentSessionBridge } = await import("../index.ts");
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
    const notify = vi.fn();
    const appendEntry = vi.fn();

    agentSessionBridge({
      appendEntry,
      on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
        handlers.set(event, handler);
      },
      registerCommand() {},
    } as never);

    const ctx = {
      cwd: "/repo/demo",
      hasUI: true,
      ui: {
        setStatus() {},
        notify,
      },
      sessionManager: {
        getBranch() {
          return [];
        },
        getSessionFile() {
          return "/tmp/pi-session.jsonl";
        },
        getSessionId() {
          return "pi-session-1";
        },
      },
    };

    await handlers.get("message_end")?.({ message: { id: "entry-1" } }, ctx);
    await handlers.get("turn_end")?.({}, ctx);

    expect(runPiMessageSync).toHaveBeenCalledTimes(2);
    expect(notify).not.toHaveBeenCalled();
    expect(appendEntry).toHaveBeenCalledOnce();
  });
});
