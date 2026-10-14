import { describe, expect, it } from "vitest";
import { runPool } from "./pool.ts";

describe("runPool", () => {
  it("processes every item", async () => {
    const seen: number[] = [];
    await runPool([1, 2, 3, 4, 5], 2, async (item) => {
      seen.push(item);
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    await runPool([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 3, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("resolves for an empty list", async () => {
    await expect(runPool([], 3, async () => {})).resolves.toBeUndefined();
  });
});
