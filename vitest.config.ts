import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "agent-session-bridge-core": resolve(
        import.meta.dirname,
        "packages/core/src/index.ts",
      ),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
