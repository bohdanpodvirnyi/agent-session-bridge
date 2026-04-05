import { describe, expect, it } from "vitest";

import { createAuditLogEntry, createDefaultConfig } from "../src/index.js";

describe("audit logging", () => {
  it("redacts secrets from log messages by default", () => {
    const entry = createAuditLogEntry(
      "info",
      "sending sk-secret123",
      createDefaultConfig().redactionPatterns,
    );
    expect(entry.level).toBe("info");
    expect(entry.message).toContain("[REDACTED]");
  });
});
