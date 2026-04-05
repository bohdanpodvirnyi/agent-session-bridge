import { describe, expect, it } from "vitest";

import {
  acquireLock,
  nonBlockingMirrorWrite,
  recoverStaleLock,
  releaseLock,
  withRetry,
} from "../src/index.js";

describe("reliability helpers", () => {
  it("retries transient failures until the action succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("try again");
      }
      return "ok";
    });

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("provides a simple stale-lock-safe lock store", async () => {
    const store = { locks: new Set<string>() };

    await expect(acquireLock(store, "registry")).resolves.toBe(true);
    await expect(acquireLock(store, "registry")).resolves.toBe(false);
    await recoverStaleLock(store, "registry");
    await expect(acquireLock(store, "registry")).resolves.toBe(true);
    await releaseLock(store, "registry");
    await expect(acquireLock(store, "registry")).resolves.toBe(true);
  });

  it("captures mirror-write failures without throwing", async () => {
    await expect(
      nonBlockingMirrorWrite(async () => {
        throw new Error("disk full");
      }),
    ).resolves.toEqual({
      ok: false,
      error: "disk full",
    });
  });
});
