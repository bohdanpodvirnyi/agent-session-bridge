import { describe, expect, it } from "vitest";

import {
  createDefaultConfig,
  isProjectEnabled,
  redactSecrets,
  shouldSyncDirection,
} from "../src/index.js";

describe("config and privacy helpers", () => {
  it("gates sync on explicit opt-in and project allowlists", () => {
    const config = createDefaultConfig();
    expect(isProjectEnabled(config, "/repo/demo")).toBe(false);

    config.optIn = true;
    config.enabledProjects = ["/repo/demo"];
    expect(isProjectEnabled(config, "/repo/demo")).toBe(true);
    expect(isProjectEnabled(config, "/repo/other")).toBe(false);
  });

  it("checks per-direction sync controls", () => {
    const config = createDefaultConfig();
    expect(shouldSyncDirection(config, "pi", "claude")).toBe(true);
    expect(shouldSyncDirection(config, "codex", "claude")).toBe(false);
  });

  it("redacts known secret patterns", () => {
    const redacted = redactSecrets(
      "token sk-secret123 and api_key=abc",
      createDefaultConfig().redactionPatterns,
    );
    expect(redacted).toContain("[REDACTED]");
    expect(redacted.includes("sk-secret123")).toBe(false);
  });
});
