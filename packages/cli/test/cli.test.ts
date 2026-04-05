import { describe, expect, it } from "vitest";

import { runCli } from "../src/index.js";

describe("CLI", () => {
  it("lists conversations", async () => {
    const lines: string[] = [];

    const exitCode = await runCli(["list"], {
      async load() {
        return {
          version: 1,
          conversations: [
            {
              bridgeSessionId: "bridge-1",
              projectKey: "/repo/demo",
              canonicalCwd: "/repo/demo",
              createdAt: "2026-04-05T10:00:00.000Z",
              updatedAt: "2026-04-05T10:00:00.000Z",
              status: "active",
              mirrors: {},
              lastWrittenOffsets: [],
            },
          ],
        };
      },
      async save() {},
      stdout(line) {
        lines.push(line);
      },
    });

    expect(exitCode).toBe(0);
    expect(lines[0]).toContain("bridge-1");
  });

  it("links a conversation to a project", async () => {
    let saved = false;

    const exitCode = await runCli(["link", "bridge-1", "/repo/demo"], {
      async load() {
        return { version: 1, conversations: [] };
      },
      async save() {
        saved = true;
      },
      stdout() {},
    });

    expect(exitCode).toBe(0);
    expect(saved).toBe(true);
  });

  it("supports dry-run linking without writing", async () => {
    let saved = false;
    const lines: string[] = [];

    const exitCode = await runCli(
      ["link", "bridge-1", "/repo/demo", "--dry-run"],
      {
        async load() {
          return { version: 1, conversations: [] };
        },
        async save() {
          saved = true;
        },
        stdout(line) {
          lines.push(line);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(saved).toBe(false);
    expect(lines[0]).toContain("dry-run");
  });

  it("queues a repair for an existing conversation", async () => {
    let saved = false;
    const exitCode = await runCli(["repair", "bridge-1"], {
      async load() {
        return {
          version: 1,
          conversations: [
            {
              bridgeSessionId: "bridge-1",
              projectKey: "/repo/demo",
              canonicalCwd: "/repo/demo",
              createdAt: "2026-04-05T10:00:00.000Z",
              updatedAt: "2026-04-05T10:00:00.000Z",
              status: "active",
              mirrors: {},
              lastWrittenOffsets: [],
            },
          ],
        };
      },
      async save() {
        saved = true;
      },
      stdout() {},
    });

    expect(exitCode).toBe(0);
    expect(saved).toBe(true);
  });

  it("audits the registry as JSON", async () => {
    const lines: string[] = [];
    const exitCode = await runCli(["audit"], {
      async load() {
        return { version: 1, conversations: [] };
      },
      async save() {},
      stdout(line) {
        lines.push(line);
      },
    });

    expect(exitCode).toBe(0);
    expect(lines[0]).toContain('"version": 1');
  });

  it("supports import-all mode", async () => {
    const lines: string[] = [];

    const exitCode = await runCli(["import", "--all"], {
      async load() {
        return { version: 1, conversations: [] };
      },
      async save() {},
      stdout(line) {
        lines.push(line);
      },
    });

    expect(exitCode).toBe(0);
    expect(lines[0]).toContain("import mode: --all");
  });
});
