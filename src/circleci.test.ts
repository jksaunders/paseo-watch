import { describe, expect, it } from "vitest";
import { fetchBranchFailureReport, isCircleciContext } from "./circleci.ts";
import { fail, fakeRun, ok } from "./test-helpers.ts";

describe("isCircleciContext", () => {
  it.each(["ci/circleci: build_and_deploy", "CircleCI", "circleci"])(
    "matches %s",
    (context) => {
      expect(isCircleciContext(context)).toBe(true);
    },
  );

  it("does not match other statuses", () => {
    expect(isCircleciContext("vercel/deploy")).toBe(false);
  });
});

describe("fetchBranchFailureReport", () => {
  it("asks for the branch report and returns it", async () => {
    const calls: string[][] = [];
    const run = fakeRun((command, args) => {
      calls.push([command, ...args]);
      return ok("  step 3 failed\n");
    });

    expect(await fetchBranchFailureReport(run, "gh/o/r", "feature")).toBe(
      "step 3 failed",
    );
    expect(calls[0]).toEqual([
      "circleci",
      "run",
      "get",
      "--project",
      "gh/o/r",
      "--branch",
      "feature",
      "--failure-report",
      "--no-interactive",
    ]);
  });

  it("returns null on error or empty output", async () => {
    expect(
      await fetchBranchFailureReport(
        fakeRun(() => fail(1)),
        "gh/o/r",
        "b",
      ),
    ).toBeNull();
    expect(
      await fetchBranchFailureReport(
        fakeRun(() => ok("   ")),
        "gh/o/r",
        "b",
      ),
    ).toBeNull();
  });
});
