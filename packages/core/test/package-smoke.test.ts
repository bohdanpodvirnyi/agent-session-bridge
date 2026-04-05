import { describe, expect, it } from "vitest";

import cliPackage from "../../cli/package.json";
import corePackage from "../package.json";

describe("package smoke", () => {
  it("exposes publishable package metadata", () => {
    expect(corePackage.name).toBe("agent-session-bridge-core");
    expect(cliPackage.bin["agent-session-bridge"]).toBe("./dist/index.js");
  });
});
