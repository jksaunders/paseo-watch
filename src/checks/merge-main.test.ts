import { describe, expect, it } from "vitest";
import { emptyState } from "../state.ts";
import {
  fail,
  fakeRun,
  ok,
  testConfig,
  testContext,
  workspace,
} from "../test-helpers.ts";
import { createMergeMainCheck } from "./merge-main.ts";

type CheckOptions = {
  branch?: string;
  sha?: string | null;
  clean?: boolean;
  upToDate?: boolean;
  mergeBase?: boolean;
  tree?: "clean" | "conflict" | "error";
  mergeOk?: boolean;
  mergeDetail?: string;
  pushOk?: boolean;
  pushDetail?: string;
  changed?: string[];
  installOk?: boolean;
  installDetail?: string;
};

const buildRun = (opts: CheckOptions) => {
  const calls: string[][] = [];
  const run = fakeRun((command, args) => {
    if (command === "pnpm") {
      calls.push([command, ...args]);
      return opts.installOk === false
        ? fail(1, opts.installDetail ?? "install boom")
        : ok();
    }
    if (command !== "git") return undefined;
    calls.push(args);
    const joined = args.join(" ");
    if (joined.includes("--symbolic-full-name")) return ok();
    if (joined.endsWith("--abbrev-ref HEAD")) {
      return ok(`${opts.branch ?? "feature"}\n`);
    }
    if (joined.includes("status --porcelain")) {
      return ok(opts.clean === false ? " M file\n" : "");
    }
    if (joined.includes("log -1 --format=%ct")) return ok("1000\n");
    if (joined.includes("rev-list --count")) return ok("0\n");
    if (joined.endsWith("rev-parse HEAD")) {
      return opts.sha === null ? fail(1) : ok(`${opts.sha ?? "abc123"}\n`);
    }
    if (joined.includes("merge-base --is-ancestor")) {
      return opts.upToDate === true ? ok() : fail(1);
    }
    if (joined.includes("merge-base ")) {
      return opts.mergeBase === false ? fail(1) : ok("base\n");
    }
    if (joined.includes("diff --name-only")) {
      return ok(`${(opts.changed ?? []).join("\n")}\n`);
    }
    if (joined.includes("merge-tree --write-tree")) {
      if (opts.tree === "error") return fail(128, "bad object");
      return opts.tree === "conflict" ? fail(1) : ok();
    }
    if (joined.includes("merge --abort")) return ok();
    if (joined.includes("merge --no-edit")) {
      return opts.mergeOk === false
        ? fail(1, opts.mergeDetail ?? "conflict")
        : ok();
    }
    if (joined.includes(" push")) {
      return opts.pushOk === false
        ? fail(1, opts.pushDetail ?? "rejected")
        : ok();
    }
    return undefined;
  });
  return { run, calls };
};

const runCheck = async (
  opts: CheckOptions = {},
  contextOverrides: Parameters<typeof testContext>[0] = {},
) => {
  const { run, calls } = buildRun(opts);
  const target = workspace();
  const context = testContext({
    run,
    workspaces: [target],
    ...contextOverrides,
  });
  const check = createMergeMainCheck();
  await check.targets(context);
  const result = await check.run(target, context);
  return { result, calls };
};

describe("mergeMain check", () => {
  it("skips main", async () => {
    const { result } = await runCheck({ branch: "main" });
    expect(result).toMatchObject({ status: "skip", detail: "not on main" });
  });

  it("skips a detached HEAD", async () => {
    const { result } = await runCheck({ branch: "HEAD" });
    expect(result).toMatchObject({ status: "skip", detail: "not on main" });
  });

  it("skips a branch with no commit", async () => {
    const { result } = await runCheck({ sha: null });
    expect(result).toMatchObject({ status: "skip", detail: "no commit" });
  });

  it("skips when there is no merge base with origin/main", async () => {
    const { result } = await runCheck({ mergeBase: false });
    expect(result).toMatchObject({
      status: "skip",
      detail: "no merge base with origin/main",
    });
  });

  it("settles when origin/main is already merged", async () => {
    const { result, calls } = await runCheck({ upToDate: true });
    expect(result).toMatchObject({
      status: "ok",
      detail: "already up to date",
      label: "up to date",
    });
    expect(calls).not.toContainEqual([
      "-C",
      "/repo/worktree",
      "merge",
      "--no-edit",
      "origin/main",
    ]);
    expect(calls).not.toContainEqual(["-C", "/repo/worktree", "push"]);
  });

  it("evaluates once across workspaces sharing a cwd", async () => {
    const { run, calls } = buildRun({ upToDate: true });
    const first = workspace({ id: "wks_1", name: "TASK-1: One" });
    const second = workspace({ id: "wks_2", name: "TASK-2: Two" });
    const context = testContext({ run, workspaces: [first, second] });
    const check = createMergeMainCheck();
    await check.targets(context);

    const [a, b] = await Promise.all([
      check.run(first, context),
      check.run(second, context),
    ]);

    expect(a).toMatchObject({ target: "TASK-1: One", status: "ok" });
    expect(b).toMatchObject({ target: "TASK-2: Two", status: "ok" });
    expect(calls.filter((args) => args.includes("--is-ancestor"))).toHaveLength(
      1,
    );
  });

  it("merges main into a clean branch and pushes right away", async () => {
    const { result, calls } = await runCheck({ tree: "clean" });
    expect(result).toMatchObject({
      status: "action",
      detail: "merged and pushed main",
      label: "merged",
    });
    expect(calls).toContainEqual([
      "-C",
      "/repo/worktree",
      "merge",
      "--no-edit",
      "origin/main",
    ]);
    expect(calls).toContainEqual(["-C", "/repo/worktree", "push"]);
  });

  it("installs dependencies when the merge changed the lockfile", async () => {
    const { result, calls } = await runCheck({
      tree: "clean",
      changed: ["pnpm-lock.yaml"],
    });
    expect(result).toMatchObject({
      status: "action",
      detail: "merged, pushed, and installed dependencies",
      label: "merged",
    });
    expect(calls).toContainEqual(["pnpm", "install", "--frozen-lockfile"]);
  });

  it("installs when the merge changed a workspace package.json", async () => {
    const { calls } = await runCheck({
      tree: "clean",
      changed: ["apps/web/package.json"],
    });
    expect(calls).toContainEqual(["pnpm", "install", "--frozen-lockfile"]);
  });

  it("does not install when the merge changed unrelated files", async () => {
    const { result, calls } = await runCheck({
      tree: "clean",
      changed: ["apps/web/src/x.ts"],
    });
    expect(result).toMatchObject({
      status: "action",
      detail: "merged and pushed main",
    });
    expect(calls).not.toContainEqual(["pnpm", "install", "--frozen-lockfile"]);
  });

  it("surfaces an install failure right after the merge", async () => {
    const state = emptyState();
    const { result } = await runCheck(
      {
        tree: "clean",
        changed: ["pnpm-lock.yaml"],
        installOk: false,
        installDetail: "no network",
      },
      { state },
    );

    expect(result).toMatchObject({
      status: "error",
      detail: "merged and pushed main; install failed — no network",
      label: "install failed",
    });
    expect(state.installs[workspace().cwd]).toBeDefined();
  });

  it("retries a queued install once already up to date", async () => {
    const target = workspace();
    const state = emptyState();
    state.installs[target.cwd] = "2020-01-01T00:00:00.000Z";
    const { run, calls } = buildRun({ upToDate: true });
    const context = testContext({ run, workspaces: [target], state });
    const check = createMergeMainCheck();
    await check.targets(context);

    const result = await check.run(target, context);

    expect(result).toMatchObject({
      status: "action",
      detail: "installed dependencies",
      label: "installed",
    });
    expect(calls).toContainEqual(["pnpm", "install", "--frozen-lockfile"]);
    expect(state.installs[target.cwd]).toBeUndefined();
  });

  it("keeps a failed install queued for the next tick", async () => {
    const target = workspace();
    const state = emptyState();
    state.installs[target.cwd] = "2020-01-01T00:00:00.000Z";
    const { run } = buildRun({
      upToDate: true,
      installOk: false,
      installDetail: "no network",
    });
    const context = testContext({ run, workspaces: [target], state });
    const check = createMergeMainCheck();
    await check.targets(context);

    const result = await check.run(target, context);

    expect(result).toMatchObject({
      status: "error",
      detail: "no network",
      label: "install failed",
    });
    expect(state.installs[target.cwd]).toBeDefined();
  });

  it("reports a queued install in a dry run without installing", async () => {
    const target = workspace();
    const state = emptyState();
    state.installs[target.cwd] = "2020-01-01T00:00:00.000Z";
    const { run, calls } = buildRun({ upToDate: true });
    const context = testContext({
      run,
      workspaces: [target],
      state,
      config: testConfig({ dryRun: true }),
    });
    const check = createMergeMainCheck();
    await check.targets(context);

    const result = await check.run(target, context);

    expect(result).toMatchObject({
      status: "action",
      detail: "would install dependencies",
      label: "to install",
    });
    expect(calls).not.toContainEqual(["pnpm", "install", "--frozen-lockfile"]);
  });

  it("reports a dry run without merging or pushing", async () => {
    const { result, calls } = await runCheck(
      { tree: "clean" },
      { config: { ...testContext().config, dryRun: true } },
    );
    expect(result).toMatchObject({
      status: "action",
      detail: "would merge main",
    });
    expect(calls).not.toContainEqual([
      "-C",
      "/repo/worktree",
      "merge",
      "--no-edit",
      "origin/main",
    ]);
    expect(calls).not.toContainEqual(["-C", "/repo/worktree", "push"]);
  });

  it("aborts a failed merge and prompts to resolve it", async () => {
    const { result, calls } = await runCheck({
      mergeOk: false,
      mergeDetail: "boom",
    });
    expect(result).toMatchObject({
      status: "action",
      label: "conflict",
      detail: "main conflicts with this branch — boom",
      eventKey: "merge-main:abc123",
      eventKind: "merge-main",
    });
    expect(calls).toContainEqual(["-C", "/repo/worktree", "merge", "--abort"]);
  });

  it("surfaces a push failure as an error", async () => {
    const { result } = await runCheck({
      pushOk: false,
      pushDetail: "rejected",
    });
    expect(result).toMatchObject({ status: "error", detail: "rejected" });
  });

  it("surfaces a merge-tree error", async () => {
    const { result } = await runCheck({ tree: "error" });
    expect(result).toMatchObject({ status: "error", detail: "bad object" });
  });

  it("skips a conflicted dirty workspace", async () => {
    const { result } = await runCheck({ tree: "conflict", clean: false });
    expect(result).toMatchObject({
      status: "skip",
      detail: "uncommitted changes",
      label: "dirty",
    });
  });

  it("skips a clean-mergeable dirty workspace without merging", async () => {
    const { result, calls } = await runCheck({ tree: "clean", clean: false });
    expect(result).toMatchObject({ status: "skip", label: "dirty" });
    expect(calls).not.toContainEqual([
      "-C",
      "/repo/worktree",
      "merge",
      "--no-edit",
      "origin/main",
    ]);
  });

  it("skips a conflicted workspace with a running agent", async () => {
    const { result } = await runCheck(
      { tree: "conflict" },
      { runningCwds: new Set([workspace().cwd]) },
    );
    expect(result).toMatchObject({
      status: "skip",
      detail: "agent running",
      label: "busy",
    });
  });

  it("skips a clean-mergeable workspace with a running agent", async () => {
    const { result, calls } = await runCheck(
      { tree: "clean" },
      { runningCwds: new Set([workspace().cwd]) },
    );
    expect(result).toMatchObject({ status: "skip", label: "busy" });
    expect(calls).not.toContainEqual([
      "-C",
      "/repo/worktree",
      "merge",
      "--no-edit",
      "origin/main",
    ]);
  });

  it("prompts once for a conflicted workspace, keyed to the head SHA", async () => {
    const { result } = await runCheck({ tree: "conflict" });
    expect(result).toMatchObject({
      status: "action",
      label: "conflict",
      eventKey: "merge-main:abc123",
      eventKind: "merge-main",
    });
  });
});
