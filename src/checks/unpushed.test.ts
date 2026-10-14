import { describe, expect, it } from "vitest";
import {
  fail,
  fakeRun,
  ok,
  testConfig,
  testContext,
  workspace,
} from "../test-helpers.ts";
import type { CheckContext, Run, RunResult } from "../types.ts";
import { createUnpushedCheck } from "./unpushed.ts";

const NOW_MS = 2_000_000_000_000;

type GitOptions = {
  branch?: string;
  clean?: boolean;
  tip?: number;
  unpushed?: number;
  upstream?: boolean;
  push?: RunResult;
};

const gitRun = (opts: GitOptions = {}) => {
  const calls: string[][] = [];
  const run: Run = fakeRun((command, args) => {
    calls.push([command, ...args]);
    if (command !== "git") return undefined;
    const joined = args.join(" ");
    if (joined.includes("push")) return opts.push ?? ok();
    if (joined.includes("--symbolic-full-name")) {
      return opts.upstream === false ? fail(1) : ok("origin/feature");
    }
    if (joined.endsWith("--abbrev-ref HEAD"))
      return ok(`${opts.branch ?? "feature"}\n`);
    if (joined.endsWith("rev-parse HEAD")) return ok("abc123\n");
    if (joined.includes("status --porcelain")) {
      return ok(opts.clean === false ? " M file\n" : "");
    }
    if (joined.includes("log -1 --format=%ct"))
      return ok(`${opts.tip ?? 1_000}\n`);
    if (joined.includes("rev-list --count"))
      return ok(`${opts.unpushed ?? 2}\n`);
    return undefined;
  });
  return { run, calls };
};

const contextFor = (run: Run, overrides: Partial<CheckContext> = {}) =>
  testContext({ run, now: () => NOW_MS, ...overrides });

describe("unpushed check", () => {
  it("lists every workspace as a target", async () => {
    const check = createUnpushedCheck();
    const context = contextFor(gitRun().run, {
      workspaces: [workspace()],
    });
    expect(await check.targets(context)).toEqual([workspace()]);
  });

  it("pushes a settled branch", async () => {
    const { run, calls } = gitRun();
    const result = await createUnpushedCheck().run(
      workspace({ name: "TASK-1" }),
      contextFor(run),
    );
    expect(result).toMatchObject({
      target: "TASK-1",
      status: "action",
      detail: "pushed 2 commits",
    });
    expect(calls.some((call) => call.includes("push"))).toBe(true);
  });

  it("does not push in a dry run", async () => {
    const { run, calls } = gitRun();
    const result = await createUnpushedCheck().run(
      workspace({ name: "TASK-1" }),
      contextFor(run, { config: testConfig({ dryRun: true }) }),
    );
    expect(result).toMatchObject({
      target: "TASK-1",
      status: "action",
      detail: "would push 2 commits",
    });
    expect(calls.some((call) => call.includes("push"))).toBe(false);
  });

  it("skips while an agent is running", async () => {
    const { run } = gitRun();
    const result = await createUnpushedCheck().run(
      workspace({ name: "TASK-1", cwd: "/repo/a" }),
      contextFor(run, { runningCwds: new Set(["/repo/a"]) }),
    );
    expect(result).toMatchObject({
      target: "TASK-1",
      status: "skip",
      detail: "agent running",
    });
  });

  it("reports a detached HEAD", async () => {
    const { run } = gitRun({ branch: "HEAD" });
    const result = await createUnpushedCheck().run(
      workspace({ name: "TASK-1" }),
      contextFor(run),
    );
    expect(result).toMatchObject({
      target: "TASK-1",
      status: "skip",
      detail: "detached HEAD",
    });
  });

  it("labels a debounced branch with the ticks remaining", async () => {
    const { run } = gitRun({ tip: 1_999_999_970 });
    const result = await createUnpushedCheck().run(
      workspace({ name: "TASK-1" }),
      contextFor(run),
    );
    expect(result).toMatchObject({
      status: "skip",
      label: "2 ticks",
      detail: expect.stringContaining("waiting"),
    });
  });

  it("uses the singular when one tick remains", async () => {
    const { run } = gitRun({ tip: 1_999_999_910 });
    const result = await createUnpushedCheck().run(
      workspace({ name: "TASK-1" }),
      contextFor(run),
    );
    expect(result).toMatchObject({
      status: "skip",
      label: "1 tick",
    });
  });

  it("surfaces push failures", async () => {
    const { run } = gitRun({ push: fail(1, "rejected") });
    const result = await createUnpushedCheck().run(
      workspace({ name: "TASK-1" }),
      contextFor(run),
    );
    expect(result).toMatchObject({
      target: "TASK-1",
      status: "error",
      detail: "rejected",
    });
  });
});
