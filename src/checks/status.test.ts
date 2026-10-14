import { describe, expect, it } from "vitest";
import { emptyState, isCommitPassed } from "../state.ts";
import { fail, fakeRun, ok, testContext, workspace } from "../test-helpers.ts";
import type { Run, RunResult } from "../types.ts";
import { createStatusCheck } from "./status.ts";

type Options = {
  branch?: string;
  sha?: string | null;
  unpushed?: number;
  status?: RunResult;
  pr?: RunResult;
  report?: RunResult;
};

const PR_URL = "https://github.com/example/repo/pull/1";

const pull = (number = 1) =>
  ok(JSON.stringify({ number, url: PR_URL, body: "" }));

const combined = (state: string, statuses: unknown[]) =>
  JSON.stringify({ state, sha: "abc123", statuses });

const statusEntry = (context: string, state: string, description = "") => ({
  context,
  state,
  description,
});

const runFor = (opts: Options = {}) => {
  const calls: string[][] = [];
  const run: Run = fakeRun((command, args) => {
    calls.push([command, ...args]);
    if (command === "git") {
      const joined = args.join(" ");
      if (joined.includes("--symbolic-full-name")) return ok("origin/feature");
      if (joined.endsWith("--abbrev-ref HEAD"))
        return ok(`${opts.branch ?? "feature"}\n`);
      if (joined.endsWith("rev-parse HEAD")) {
        return opts.sha === null ? fail(1) : ok(`${opts.sha ?? "abc123"}\n`);
      }
      if (joined.includes("status --porcelain")) return ok("");
      if (joined.includes("log -1 --format=%ct")) return ok("1000\n");
      if (joined.includes("rev-list --count"))
        return ok(`${opts.unpushed ?? 0}\n`);
    }
    if (command === "gh") {
      if (args[0] === "pr") return opts.pr ?? pull();
      return (
        opts.status ?? ok(combined("success", [statusEntry("ci", "success")]))
      );
    }
    if (command === "circleci") {
      return opts.report ?? ok("job build failed\n");
    }
    return undefined;
  });
  return { run, calls };
};

const contextFor = (run: Run, state = emptyState()) =>
  testContext({ run, state, workspaces: [workspace()] });

const ghCalls = (calls: string[][]) => calls.filter((call) => call[0] === "gh");

const ghApiCalls = (calls: string[][]) =>
  ghCalls(calls).filter((call) => call[1] === "api");

describe("status check", () => {
  it("skips an unpushed commit without asking GitHub", async () => {
    const { run, calls } = runFor({ unpushed: 2 });
    const result = await createStatusCheck().run(
      workspace({ name: "TASK-1" }),
      contextFor(run),
    );

    expect(result).toMatchObject({
      status: "skip",
      label: "not pushed",
      detail: "commit not pushed to remote",
    });
    expect(ghCalls(calls)).toHaveLength(0);
  });

  it("passes and records a commit whose checks all passed", async () => {
    const { run, calls } = runFor();
    const state = emptyState();
    const result = await createStatusCheck().run(
      workspace({ name: "TASK-1" }),
      contextFor(run, state),
    );

    expect(result).toMatchObject({
      target: "TASK-1",
      status: "ok",
      detail: "status checks passed",
      label: "passed",
    });
    expect(isCommitPassed(state, "abc123", 1)).toBe(true);
    expect(ghApiCalls(calls)).toHaveLength(1);
  });

  it("never re-checks a commit that already passed for the same PR", async () => {
    const { run, calls } = runFor();
    const state = emptyState();
    state.commits.abc123 = {
      state: "passed",
      checkedAt: "2020-01-01T00:00:00.000Z",
      pull: 1,
    };

    const result = await createStatusCheck().run(
      workspace({ name: "TASK-1" }),
      contextFor(run, state),
    );

    expect(result).toMatchObject({ status: "ok", label: "passed" });
    expect(ghApiCalls(calls)).toHaveLength(0);
  });

  it("skips a commit with no pull request without checking statuses", async () => {
    const { run, calls } = runFor({
      pr: fail(1, 'no pull requests found for branch "feature"'),
    });
    const result = await createStatusCheck().run(
      workspace({ name: "TASK-1" }),
      contextFor(run),
    );

    expect(result).toMatchObject({
      status: "skip",
      detail: "no pull request",
      label: "no pr",
    });
    expect(ghApiCalls(calls)).toHaveLength(0);
  });

  it("does not trust a cached pre-PR pass while the branch has no pull request", async () => {
    const { run, calls } = runFor({
      pr: fail(1, 'no pull requests found for branch "feature"'),
    });
    const state = emptyState();
    state.commits.abc123 = {
      state: "passed",
      checkedAt: "2020-01-01T00:00:00.000Z",
      pull: null,
    };

    const result = await createStatusCheck().run(
      workspace({ name: "TASK-1" }),
      contextFor(run, state),
    );

    expect(result).toMatchObject({ status: "skip", label: "no pr" });
    expect(ghApiCalls(calls)).toHaveLength(0);
  });

  it("reports a pull request fetch error", async () => {
    const { run, calls } = runFor({ pr: fail(1, "no auth") });
    const result = await createStatusCheck().run(
      workspace({ name: "TASK-1" }),
      contextFor(run),
    );

    expect(result).toMatchObject({ status: "error", detail: "no auth" });
    expect(ghApiCalls(calls)).toHaveLength(0);
  });

  it("re-evaluates a pass recorded before a PR existed", async () => {
    const { run } = runFor({
      status: ok(combined("pending", [statusEntry("ci", "pending")])),
    });
    const state = emptyState();
    state.commits.abc123 = {
      state: "passed",
      checkedAt: "2020-01-01T00:00:00.000Z",
      pull: null,
    };

    const result = await createStatusCheck().run(
      workspace({ name: "TASK-1" }),
      contextFor(run, state),
    );

    expect(result).toMatchObject({ status: "skip", label: "pending" });
    expect(state.commits.abc123?.state).toBe("pending");
  });

  it("surfaces a regression to pending for a SHA cached before the PR", async () => {
    const { run } = runFor({
      status: ok(combined("failure", [statusEntry("ci", "pending")])),
    });
    const state = emptyState();
    state.commits.abc123 = {
      state: "passed",
      checkedAt: "2020-01-01T00:00:00.000Z",
      pull: null,
    };

    const result = await createStatusCheck().run(
      workspace({ name: "TASK-1" }),
      contextFor(run, state),
    );

    expect(result).toMatchObject({ status: "skip", label: "pending" });
    expect(isCommitPassed(state, "abc123", 1)).toBe(false);
  });

  it("flags a generic failure", async () => {
    const { run } = runFor({
      status: ok(
        combined("failure", [statusEntry("vercel/deploy", "failure", "boom")]),
      ),
    });
    const result = await createStatusCheck().run(
      workspace({ name: "TASK-1" }),
      contextFor(run),
    );

    expect(result).toMatchObject({
      status: "action",
      label: "failed",
      detail: "vercel/deploy: boom",
      eventKey: "status:abc123",
      eventKind: "status",
    });
  });

  it("flags a CircleCI failure with the branch report", async () => {
    const { run, calls } = runFor({
      status: ok(
        combined("failure", [
          statusEntry("ci/circleci: build_and_deploy", "failure", "failed"),
        ]),
      ),
      report: ok("step 3: pnpm run check-types\n"),
    });
    const result = await createStatusCheck().run(
      workspace({ name: "TASK-1" }),
      contextFor(run),
    );

    expect(result).toMatchObject({
      status: "action",
      label: "circleci",
      eventKind: "circleci",
      eventKey: "status:abc123",
    });
    expect(result.detail).toContain("CircleCI failure");
    expect(result.detail).toContain("step 3: pnpm run check-types");
    expect(calls.some((call) => call[0] === "circleci")).toBe(true);
  });

  it("falls back when no failure report is available", async () => {
    const { run } = runFor({
      status: ok(
        combined("error", [statusEntry("ci/circleci: build", "error")]),
      ),
      report: fail(1),
    });
    const result = await createStatusCheck().run(
      workspace({ name: "TASK-1" }),
      contextFor(run),
    );
    expect(result.detail).toBe("CircleCI failure — ci/circleci: build");
  });

  it("waits for every check to finish before flagging a failure", async () => {
    const { run, calls } = runFor({
      status: ok(
        combined("failure", [
          statusEntry("ci/circleci: build_and_deploy", "failure", "failed"),
          statusEntry("vercel/deploy", "pending"),
        ]),
      ),
    });
    const result = await createStatusCheck().run(
      workspace({ name: "TASK-1" }),
      contextFor(run),
    );

    expect(result).toMatchObject({ status: "skip", label: "pending" });
    expect(result.eventKey).toBeUndefined();
    expect(calls.some((call) => call[0] === "circleci")).toBe(false);
  });

  it("flags a failure once all checks are terminal", async () => {
    const { run } = runFor({
      status: ok(
        combined("failure", [
          statusEntry("ci/circleci: build", "success"),
          statusEntry("vercel/deploy", "failure", "boom"),
        ]),
      ),
    });
    const result = await createStatusCheck().run(
      workspace({ name: "TASK-1" }),
      contextFor(run),
    );
    expect(result).toMatchObject({ status: "action", label: "failed" });
  });

  it("shows running checks as pending", async () => {
    const { run } = runFor({
      status: ok(combined("pending", [statusEntry("ci", "pending")])),
    });
    const result = await createStatusCheck().run(
      workspace({ name: "TASK-1" }),
      contextFor(run),
    );
    expect(result).toMatchObject({ status: "skip", label: "pending" });
  });

  it("treats a commit with no statuses as no ci", async () => {
    const { run } = runFor({ status: ok(combined("pending", [])) });
    const result = await createStatusCheck().run(
      workspace({ name: "TASK-1" }),
      contextFor(run),
    );
    expect(result).toMatchObject({ status: "skip", label: "no ci" });
  });

  it("reports a gh error", async () => {
    const { run } = runFor({ status: fail(1, "no auth") });
    const result = await createStatusCheck().run(
      workspace({ name: "TASK-1" }),
      contextFor(run),
    );
    expect(result).toMatchObject({ status: "error", detail: "no auth" });
  });

  it("skips main and detached HEADs", async () => {
    const check = createStatusCheck();
    const main = await check.run(
      workspace({ name: "main" }),
      contextFor(runFor({ branch: "main" }).run),
    );
    expect(main).toMatchObject({ status: "skip", label: "n/a" });

    const detached = await check.run(
      workspace({ name: "x" }),
      contextFor(runFor({ sha: null }).run),
    );
    expect(detached).toMatchObject({ status: "skip", label: "n/a" });
  });
});
