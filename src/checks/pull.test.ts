import { describe, expect, it } from "vitest";
import { SELF_DIR } from "../self.ts";
import { emptyState } from "../state.ts";
import {
  fail,
  fakeRun,
  ok,
  testConfig,
  testContext,
  workspace,
} from "../test-helpers.ts";
import type { Run, RunResult } from "../types.ts";
import { createPullCheck } from "./pull.ts";

// The watcher lives at the repo root in this reference repo.
const repoRoot = SELF_DIR;

type Options = {
  branch?: string;
  clean?: boolean;
  upstream?: boolean;
  behind?: number;
  pull?: RunResult;
  changed?: string[];
  toplevel?: RunResult;
  installOk?: boolean;
  installDetail?: string;
};

const runFor = (opts: Options = {}) => {
  const calls: string[][] = [];
  const run: Run = fakeRun((command, args) => {
    calls.push([command, ...args]);
    if (command === "pnpm") {
      return opts.installOk === false
        ? fail(1, opts.installDetail ?? "install boom")
        : ok();
    }
    if (command !== "git") return undefined;
    const joined = args.join(" ");
    if (joined.includes("pull")) return opts.pull ?? ok("Updating\n");
    if (joined.includes("HEAD..@{u}")) return ok(`${opts.behind ?? 0}\n`);
    if (joined.includes("--show-toplevel")) {
      return opts.toplevel ?? ok(`${repoRoot}\n`);
    }
    if (joined.includes("diff --name-only")) {
      return ok(`${(opts.changed ?? []).join("\n")}\n`);
    }
    if (joined.includes("--symbolic-full-name")) {
      return opts.upstream === false ? fail(1) : ok("origin/main");
    }
    if (joined.endsWith("--abbrev-ref HEAD"))
      return ok(`${opts.branch ?? "main"}\n`);
    if (joined.endsWith("rev-parse HEAD")) return ok("abc123\n");
    if (joined.includes("status --porcelain")) {
      return ok(opts.clean === false ? " M file\n" : "");
    }
    if (joined.includes("log -1 --format=%ct")) return ok("1000\n");
    if (joined.includes("rev-list --count HEAD --not --remotes"))
      return ok("0\n");
    return undefined;
  });
  return { run, calls };
};

const pulled = (calls: string[][]) =>
  calls.some((call) => call.includes("pull"));

describe("pull check", () => {
  it("lists every workspace as a target", async () => {
    const check = createPullCheck();
    const context = testContext({ workspaces: [workspace()] });
    expect(await check.targets(context)).toEqual([workspace()]);
  });

  it("leaves non-main workspaces alone", async () => {
    const { run, calls } = runFor({ branch: "feature" });
    const res = await createPullCheck().run(
      workspace({ name: "TASK-1" }),
      testContext({ run }),
    );
    expect(res).toMatchObject({ status: "skip", label: "n/a" });
    expect(pulled(calls)).toBe(false);
  });

  it("does not pull a dirty main workspace", async () => {
    const { run, calls } = runFor({ clean: false });
    const res = await createPullCheck().run(
      workspace({ name: "main" }),
      testContext({ run }),
    );
    expect(res).toMatchObject({ status: "skip", label: "dirty" });
    expect(pulled(calls)).toBe(false);
  });

  it("reports an up-to-date main without pulling", async () => {
    const { run, calls } = runFor({ behind: 0 });
    const res = await createPullCheck().run(
      workspace({ name: "main" }),
      testContext({ run }),
    );
    expect(res).toMatchObject({ status: "ok", label: "up to date" });
    expect(pulled(calls)).toBe(false);
  });

  it("fast-forwards a behind main", async () => {
    const { run, calls } = runFor({ behind: 3 });
    const res = await createPullCheck().run(
      workspace({ name: "main" }),
      testContext({ run }),
    );
    expect(res).toMatchObject({
      status: "action",
      label: "pulled",
      detail: "pulled 3 commits",
    });
    expect(pulled(calls)).toBe(true);
    expect(calls).toContainEqual([
      "git",
      "-C",
      "/repo/worktree",
      "pull",
      "--ff-only",
    ]);
  });

  it("installs dependencies after a pull that changed the lockfile", async () => {
    const { run, calls } = runFor({ behind: 2, changed: ["pnpm-lock.yaml"] });
    const res = await createPullCheck().run(
      workspace({ name: "main" }),
      testContext({ run }),
    );
    expect(res).toMatchObject({
      status: "action",
      label: "pulled",
      detail: "pulled 2 commits; installed dependencies",
    });
    expect(calls).toContainEqual(["pnpm", "install", "--frozen-lockfile"]);
  });

  it("does not install after a pull that changed unrelated files", async () => {
    const { run, calls } = runFor({
      behind: 1,
      changed: ["apps/web/src/x.ts"],
    });
    const res = await createPullCheck().run(
      workspace({ name: "main" }),
      testContext({ run }),
    );
    expect(res).toMatchObject({ detail: "pulled 1 commit" });
    expect(calls).not.toContainEqual(["pnpm", "install", "--frozen-lockfile"]);
  });

  it("retries a queued install when main is already up to date", async () => {
    const { run, calls } = runFor({ behind: 0 });
    const state = emptyState();
    state.installs["/repo/worktree"] = "2020-01-01T00:00:00.000Z";
    const res = await createPullCheck().run(
      workspace({ name: "main" }),
      testContext({ run, state }),
    );
    expect(res).toMatchObject({
      status: "action",
      detail: "installed dependencies",
      label: "installed",
    });
    expect(calls).toContainEqual(["pnpm", "install", "--frozen-lockfile"]);
    expect(state.installs["/repo/worktree"]).toBeUndefined();
  });

  it("keeps a failed install queued for the next tick", async () => {
    const { run } = runFor({
      behind: 1,
      changed: ["pnpm-lock.yaml"],
      installOk: false,
      installDetail: "no network",
    });
    const state = emptyState();
    const res = await createPullCheck().run(
      workspace({ name: "main" }),
      testContext({ run, state }),
    );
    expect(res).toMatchObject({
      status: "error",
      detail: "pulled 1 commit; install failed — no network",
      label: "install failed",
    });
    expect(state.installs["/repo/worktree"]).toBeDefined();
  });

  it("pulls once for workspaces that share a cwd", async () => {
    const { run, calls } = runFor({ behind: 3 });
    const check = createPullCheck();
    const context = testContext({
      run,
      workspaces: [
        workspace({ id: "wks_main", name: "main" }),
        workspace({ id: "wks_watch", name: "Paseo watch" }),
        workspace({ id: "wks_plane", name: "Plane" }),
      ],
    });

    const targets = await check.targets(context);
    const results = await Promise.all(
      targets.map((target) => check.run(target, context)),
    );

    expect(calls.filter((call) => call.includes("pull"))).toHaveLength(1);
    expect(results.map((res) => res.target)).toEqual([
      "main",
      "Paseo watch",
      "Plane",
    ]);
    for (const res of results) {
      expect(res).toMatchObject({
        status: "action",
        label: "pulled",
        detail: "pulled 3 commits",
      });
    }
  });

  it("pulls again on the next tick after targets resets", async () => {
    const { run, calls } = runFor({ behind: 3 });
    const check = createPullCheck();
    const context = testContext({
      run,
      workspaces: [workspace({ id: "wks_main", name: "main" })],
    });

    const tick = async () => {
      const targets = await check.targets(context);
      return Promise.all(targets.map((target) => check.run(target, context)));
    };
    await tick();
    await tick();

    expect(calls.filter((call) => call.includes("pull"))).toHaveLength(2);
  });

  it("hints a restart when the pull changed the watcher itself", async () => {
    const { run } = runFor({
      behind: 1,
      changed: ["src/checks/pull.ts"],
    });
    const res = await createPullCheck().run(
      workspace({ name: "main" }),
      testContext({ run }),
    );
    expect(res.notice).toBe("restart to pick up new watcher code");
  });

  it("stays quiet when the pull changed other files", async () => {
    const { run } = runFor({
      behind: 1,
      changed: ["apps/web/src/x.ts"],
    });
    const res = await createPullCheck().run(
      workspace({ name: "main" }),
      testContext({ run }),
    );
    expect(res.notice).toBeUndefined();
  });

  it("reports what it would do in a dry run", async () => {
    const { run, calls } = runFor({ behind: 1 });
    const res = await createPullCheck().run(
      workspace({ name: "main" }),
      testContext({ run, config: testConfig({ dryRun: true }) }),
    );
    expect(res).toMatchObject({
      status: "action",
      label: "to pull",
      detail: "would pull 1 commit",
    });
    expect(pulled(calls)).toBe(false);
  });

  it("surfaces a failed pull", async () => {
    const { run } = runFor({
      behind: 2,
      pull: fail(1, "Not possible to fast-forward"),
    });
    const res = await createPullCheck().run(
      workspace({ name: "main" }),
      testContext({ run }),
    );
    expect(res).toMatchObject({
      status: "error",
      detail: "Not possible to fast-forward",
    });
  });

  it("skips main without an upstream", async () => {
    const { run } = runFor({ upstream: false });
    const res = await createPullCheck().run(
      workspace({ name: "main" }),
      testContext({ run }),
    );
    expect(res).toMatchObject({ status: "skip", label: "no upstream" });
  });
});
