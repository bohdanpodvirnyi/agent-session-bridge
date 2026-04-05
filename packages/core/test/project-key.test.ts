import { describe, expect, it } from "vitest";

import { deriveProjectKey } from "../src/index.js";

describe("deriveProjectKey", () => {
  it("uses the repo root as the project key when a git repo is detected", async () => {
    const result = await deriveProjectKey("/work/repo/apps/web", {
      async realpath(path) {
        return path;
      },
      async findRepoRoot() {
        return "/work/repo";
      },
    });

    expect(result).toEqual({
      canonicalCwd: "/work/repo/apps/web",
      projectKey: "/work/repo",
    });
  });

  it("normalizes symlinked paths via realpath before deriving the key", async () => {
    const result = await deriveProjectKey("/link/project", {
      async realpath() {
        return "/real/worktree/project";
      },
      async findRepoRoot(cwd) {
        return cwd;
      },
    });

    expect(result).toEqual({
      canonicalCwd: "/real/worktree/project",
      projectKey: "/real/worktree/project",
    });
  });

  it("falls back to the canonical cwd when no repo root exists", async () => {
    const result = await deriveProjectKey("/tmp/demo", {
      async realpath(path) {
        return `${path}/`;
      },
      async findRepoRoot() {
        return null;
      },
    });

    expect(result).toEqual({
      canonicalCwd: "/tmp/demo",
      projectKey: "/tmp/demo",
    });
  });
});
