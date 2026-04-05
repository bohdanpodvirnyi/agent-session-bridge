import { describe, expect, it } from "vitest";

import {
  encodeCwdForClaudeCode,
  encodeCwdForPi,
  findGitRepoRoot,
  getClaudeCodeProjectDir,
  getCodexSessionDir,
  getPiSessionDir,
} from "../src/index.js";

describe("path helpers", () => {
  it("encodes Pi session directories", () => {
    expect(encodeCwdForPi("/Users/demo/project")).toBe(
      "--Users-demo-project--",
    );
  });

  it("encodes Claude Code project directories", () => {
    expect(encodeCwdForClaudeCode("/Users/demo/project")).toBe(
      "-Users-demo-project",
    );
  });

  it("builds native session directories", () => {
    expect(getPiSessionDir("/repo/demo", "/home/test")).toContain(
      "/home/test/.pi/agent/sessions/",
    );
    expect(getClaudeCodeProjectDir("/repo/demo", "/home/test")).toContain(
      "/home/test/.claude/projects/",
    );
    expect(
      getCodexSessionDir(new Date("2026-04-05T10:00:00.000Z"), "/home/test"),
    ).toBe("/home/test/.codex/sessions/2026/04/05");
  });

  it("walks up the directory tree to find a git repository root", async () => {
    const root = await findGitRepoRoot("/repo/demo/apps/web", {
      async exists(path) {
        return path === "/repo/demo/.git";
      },
    });

    expect(root).toBe("/repo/demo");
  });
});
