import { describe, expect, it } from "vitest";

import {
  emptyRegistry,
  findConversationsByProjectKey,
  findConversationByProjectKey,
  findConversationByNativeSession,
  loadRegistry,
  saveRegistry,
  upsertConversation,
  type BridgeRegistry,
  type BridgeConversation,
  type FileSystemLike,
} from "../src/index.js";

describe("registry helpers", () => {
  it("returns an empty registry when no registry file exists", async () => {
    const fs = {
      async readFile() {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
    } satisfies Pick<FileSystemLike, "readFile">;

    await expect(loadRegistry("/tmp/registry.json", fs)).resolves.toEqual(
      emptyRegistry(),
    );
  });

  it("saves the registry with an atomic temp-file rename", async () => {
    const writes: string[] = [];
    const fs = {
      async mkdir(path: string) {
        writes.push(`mkdir:${path}`);
      },
      async writeFile(path: string, data: string) {
        writes.push(`write:${path}:${data.includes('"version": 1')}`);
      },
      async rename(from: string, to: string) {
        writes.push(`rename:${from}->${to}`);
      },
    } satisfies Pick<FileSystemLike, "mkdir" | "writeFile" | "rename">;

    await saveRegistry("/state/registry.json", emptyRegistry(), fs);

    expect(writes).toEqual([
      "mkdir:/state",
      "write:/state/registry.json.tmp:true",
      "rename:/state/registry.json.tmp->/state/registry.json",
    ]);
  });

  it("finds a conversation by project key", () => {
    const registry: BridgeRegistry = {
      version: 1,
      conversations: [
        {
          bridgeSessionId: "bridge-1",
          projectKey: "/repo/a",
          canonicalCwd: "/repo/a",
          createdAt: "2026-04-05T10:00:00.000Z",
          updatedAt: "2026-04-05T10:00:00.000Z",
          status: "active",
          mirrors: {},
          lastWrittenOffsets: [],
        },
      ],
    };

    expect(
      findConversationByProjectKey(registry, "/repo/a")?.bridgeSessionId,
    ).toBe("bridge-1");
    expect(findConversationByProjectKey(registry, "/repo/b")).toBeUndefined();
  });

  it("finds a conversation by native session id across tools", () => {
    const registry: BridgeRegistry = {
      version: 1,
      conversations: [
        {
          bridgeSessionId: "bridge-1",
          projectKey: "/repo/a",
          canonicalCwd: "/repo/a",
          createdAt: "2026-04-05T10:00:00.000Z",
          updatedAt: "2026-04-05T10:00:00.000Z",
          status: "active",
          mirrors: {
            claude: {
              nativeId: "claude-session-1",
              sessionPath: "/claude/projects/repo-a/session.jsonl",
            },
          },
          lastWrittenOffsets: [],
        },
      ],
    };

    expect(
      findConversationByNativeSession(registry, "claude", "claude-session-1")
        ?.bridgeSessionId,
    ).toBe("bridge-1");
    expect(
      findConversationByNativeSession(registry, "pi", "pi-session-1"),
    ).toBeUndefined();
  });

  it("returns all conversations for a project key when multiple sessions exist", () => {
    const registry: BridgeRegistry = {
      version: 1,
      conversations: [
        {
          bridgeSessionId: "bridge-1",
          projectKey: "/repo/a",
          canonicalCwd: "/repo/a",
          createdAt: "2026-04-05T10:00:00.000Z",
          updatedAt: "2026-04-05T10:00:00.000Z",
          status: "active",
          mirrors: {},
          lastWrittenOffsets: [],
        },
        {
          bridgeSessionId: "bridge-2",
          projectKey: "/repo/a",
          canonicalCwd: "/repo/a",
          createdAt: "2026-04-05T11:00:00.000Z",
          updatedAt: "2026-04-05T11:00:00.000Z",
          status: "active",
          mirrors: {},
          lastWrittenOffsets: [],
        },
      ],
    };

    expect(findConversationsByProjectKey(registry, "/repo/a")).toHaveLength(2);
  });

  it("upserts a new conversation when the bridge id is missing", () => {
    const next = upsertConversation(emptyRegistry(), {
      bridgeSessionId: "bridge-1",
      projectKey: "/repo/a",
      canonicalCwd: "/repo/a",
      createdAt: "2026-04-05T10:00:00.000Z",
      updatedAt: "2026-04-05T10:00:00.000Z",
      status: "active",
      mirrors: {},
      lastWrittenOffsets: [],
    });

    expect(next.conversations).toHaveLength(1);
    expect(next.conversations[0]?.bridgeSessionId).toBe("bridge-1");
  });

  it("upserts an existing conversation without losing its createdAt timestamp", () => {
    const existing: BridgeConversation = {
      bridgeSessionId: "bridge-1",
      projectKey: "/repo/a",
      canonicalCwd: "/repo/a",
      createdAt: "2026-04-05T10:00:00.000Z",
      updatedAt: "2026-04-05T10:00:00.000Z",
      status: "active",
      mirrors: {
        pi: {
          nativeId: "pi-session-1",
          sessionPath: "/pi/sessions/repo-a/session.jsonl",
        },
      },
      lastWrittenOffsets: [],
    };

    const next = upsertConversation(
      {
        version: 1,
        conversations: [existing],
      },
      {
        ...existing,
        updatedAt: "2026-04-05T11:00:00.000Z",
        mirrors: {
          ...existing.mirrors,
          claude: {
            nativeId: "claude-session-1",
            sessionPath: "/claude/projects/repo-a/session.jsonl",
          },
        },
      },
    );

    expect(next.conversations).toHaveLength(1);
    expect(next.conversations[0]).toMatchObject({
      bridgeSessionId: "bridge-1",
      createdAt: "2026-04-05T10:00:00.000Z",
      updatedAt: "2026-04-05T11:00:00.000Z",
    });
    expect(next.conversations[0]?.mirrors.pi?.nativeId).toBe("pi-session-1");
    expect(next.conversations[0]?.mirrors.claude?.nativeId).toBe(
      "claude-session-1",
    );
  });
});
