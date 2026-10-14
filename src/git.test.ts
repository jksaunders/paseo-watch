import { describe, expect, it } from "vitest";
import {
  abortMerge,
  changedFiles,
  decidePush,
  dependencyFilesChanged,
  mainAlreadyMerged,
  mergeMain,
  mergeTreeConflicts,
  pushBranch,
  readBranchState,
  refreshRemotes,
  sharesMergeBase,
} from "./git.ts";
import { fail, fakeRun, ok } from "./test-helpers.ts";

type GitState = {
  branch?: string;
  sha?: string | null;
  clean?: boolean;
  tip?: number;
  unpushed?: number;
  upstream?: boolean;
};

const gitRun = (opts: GitState = {}) => {
  const calls: string[][] = [];
  const run = fakeRun((command, args) => {
    if (command !== "git") return undefined;
    calls.push(args);
    const joined = args.join(" ");
    if (joined.includes("--symbolic-full-name")) {
      return opts.upstream ? ok("origin/feature") : fail(1, "no upstream");
    }
    if (joined.endsWith("--abbrev-ref HEAD")) {
      return ok(`${opts.branch ?? "feature"}\n`);
    }
    if (joined.endsWith("rev-parse HEAD")) {
      return opts.sha === null ? fail(1) : ok(`${opts.sha ?? "abc123"}\n`);
    }
    if (joined.includes("status --porcelain")) {
      return ok(opts.clean === false ? " M file\n" : "");
    }
    if (joined.includes("log -1 --format=%ct")) {
      return ok(`${opts.tip ?? 1_000_000}\n`);
    }
    if (joined.includes("rev-list --count")) {
      return ok(`${opts.unpushed ?? 0}\n`);
    }
    return undefined;
  });
  return { run, calls };
};

describe("decidePush", () => {
  const base = {
    branch: "feature",
    clean: true,
    tipSeconds: 1_000,
    unpushed: 2,
    agentRunning: false,
    debounceSeconds: 120,
    intervalSeconds: 60,
    nowSeconds: 2_000,
    dryRun: false,
  };

  it("pushes a settled branch", () => {
    expect(decidePush(base)).toEqual({
      kind: "push",
      reason: "pushed 2 commits",
    });
  });

  it("uses the singular for one commit", () => {
    expect(decidePush({ ...base, unpushed: 1 })).toEqual({
      kind: "push",
      reason: "pushed 1 commit",
    });
  });

  it("reports a dry run without pushing", () => {
    expect(decidePush({ ...base, dryRun: true })).toEqual({
      kind: "would-push",
      reason: "would push 2 commits",
    });
  });

  it.each([
    [{ branch: null }, "detached HEAD"],
    [{ branch: "main" }, "on main"],
    [{ unpushed: 0 }, "nothing to push"],
    [{ clean: false }, "uncommitted changes"],
    [{ agentRunning: true }, "agent running"],
  ] as const)("skips with %o", (override, reason) => {
    expect(decidePush({ ...base, ...override })).toEqual({
      kind: "skip",
      reason,
    });
  });

  it("waits for the tip to settle", () => {
    const decision = decidePush({
      ...base,
      tipSeconds: 1_970,
      nowSeconds: 2_000,
    });
    expect(decision).toEqual({
      kind: "skip",
      reason: "waiting 90s for the tip to settle",
      ticksRemaining: 2,
    });
  });

  it("rounds remaining ticks up within the interval", () => {
    const decision = decidePush({
      ...base,
      tipSeconds: 1_900,
      nowSeconds: 2_000,
    });
    expect(decision).toEqual({
      kind: "skip",
      reason: "waiting 20s for the tip to settle",
      ticksRemaining: 1,
    });
  });

  it("clamps remaining ticks to at least one", () => {
    const decision = decidePush({
      ...base,
      tipSeconds: 1_881,
      nowSeconds: 2_000,
      intervalSeconds: 600,
    });
    expect(decision).toEqual({
      kind: "skip",
      reason: "waiting 1s for the tip to settle",
      ticksRemaining: 1,
    });
  });

  it("pushes once the tip reaches the debounce boundary", () => {
    const decision = decidePush({
      ...base,
      tipSeconds: 1_880,
      nowSeconds: 2_000,
    });
    expect(decision.kind).toBe("push");
  });

  it("pushes when the tip age is unknown", () => {
    expect(decidePush({ ...base, tipSeconds: null }).kind).toBe("push");
  });
});

describe("readBranchState", () => {
  it("reads a feature branch", async () => {
    const { run } = gitRun({
      branch: "feature",
      clean: true,
      tip: 1_234,
      unpushed: 3,
      upstream: true,
    });
    expect(await readBranchState(run, "/repo/worktree")).toEqual({
      branch: "feature",
      headSha: "abc123",
      clean: true,
      tipSeconds: 1_234,
      unpushed: 3,
      hasUpstream: true,
    });
  });

  it("reports a detached HEAD as no branch", async () => {
    const { run } = gitRun({ branch: "HEAD" });
    expect((await readBranchState(run, "/repo")).branch).toBeNull();
  });

  it("reports dirty trees and missing upstreams", async () => {
    const { run } = gitRun({ clean: false, upstream: false });
    const state = await readBranchState(run, "/repo");
    expect(state.clean).toBe(false);
    expect(state.hasUpstream).toBe(false);
  });

  it("treats an unparseable tip timestamp as unknown", async () => {
    const run = fakeRun((command, args) => {
      if (command !== "git") return undefined;
      const joined = args.join(" ");
      if (joined.includes("--symbolic-full-name")) return fail(1);
      if (joined.endsWith("--abbrev-ref HEAD")) return ok("feature\n");
      if (joined.endsWith("rev-parse HEAD")) return ok("abc123\n");
      if (joined.includes("status --porcelain")) return ok("");
      if (joined.includes("log -1 --format=%ct")) return ok("NaN\n");
      if (joined.includes("rev-list --count")) return ok("garbage\n");
      return undefined;
    });
    const state = await readBranchState(run, "/repo");
    expect(state.tipSeconds).toBeNull();
    expect(state.unpushed).toBe(0);
  });
});

describe("pushBranch", () => {
  it("pushes without setting an upstream when one exists", async () => {
    const calls: string[][] = [];
    const run = fakeRun((command, args) => {
      calls.push([command, ...args]);
      return ok();
    });
    await pushBranch(run, "/repo", "feature", true);
    expect(calls[0]).toEqual(["git", "-C", "/repo", "push"]);
  });

  it("sets the upstream when missing", async () => {
    const calls: string[][] = [];
    const run = fakeRun((command, args) => {
      calls.push([command, ...args]);
      return ok();
    });
    await pushBranch(run, "/repo", "feature", false);
    expect(calls[0]).toEqual([
      "git",
      "-C",
      "/repo",
      "push",
      "-u",
      "origin",
      "feature",
    ]);
  });

  it("surfaces push failures", async () => {
    const result = await pushBranch(
      fakeRun(() => fail(1, "rejected")),
      "/repo",
      "feature",
      true,
    );
    expect(result).toEqual({ ok: false, detail: "rejected" });
  });
});

describe("refreshRemotes", () => {
  it("fetches from the repository that owns the shared object store", async () => {
    const calls: string[][] = [];
    const run = fakeRun((command, args) => {
      calls.push([command, ...args]);
      if (args.includes("--git-common-dir")) return ok("/repo/.git\n");
      return ok();
    });

    await refreshRemotes(run, "/repo/worktrees/a");
    expect(calls).toContainEqual(["git", "-C", "/repo", "fetch", "origin"]);
  });
});

describe("sharesMergeBase", () => {
  it("is true when origin/main shares a base", async () => {
    const run = fakeRun(() => ok("abc123\n"));
    expect(await sharesMergeBase(run, "/repo")).toBe(true);
  });

  it("is false when there is no base", async () => {
    const run = fakeRun(() => fail(1));
    expect(await sharesMergeBase(run, "/repo")).toBe(false);
  });
});

describe("mainAlreadyMerged", () => {
  it("is true when origin/main is an ancestor of HEAD", async () => {
    const calls: string[][] = [];
    const run = fakeRun((command, args) => {
      calls.push([command, ...args]);
      return ok();
    });
    expect(await mainAlreadyMerged(run, "/repo")).toBe(true);
    expect(calls[0]).toEqual([
      "git",
      "-C",
      "/repo",
      "merge-base",
      "--is-ancestor",
      "origin/main",
      "HEAD",
    ]);
  });

  it("is false when origin/main is not an ancestor", async () => {
    const run = fakeRun(() => fail(1));
    expect(await mainAlreadyMerged(run, "/repo")).toBe(false);
  });
});

describe("mergeTreeConflicts", () => {
  it("reports a clean merge", async () => {
    const run = fakeRun(() => ok());
    expect(await mergeTreeConflicts(run, "/repo")).toEqual({ kind: "clean" });
  });

  it("reports a conflict on exit 1", async () => {
    const run = fakeRun(() => fail(1));
    expect(await mergeTreeConflicts(run, "/repo")).toEqual({
      kind: "conflict",
    });
  });

  it("surfaces other exit codes as errors", async () => {
    const run = fakeRun(() => fail(128, "fatal: bad object"));
    expect(await mergeTreeConflicts(run, "/repo")).toEqual({
      kind: "error",
      detail: "fatal: bad object",
    });
  });
});

describe("mergeMain", () => {
  it("merges origin/main", async () => {
    const calls: string[][] = [];
    const run = fakeRun((command, args) => {
      calls.push([command, ...args]);
      return ok();
    });
    expect(await mergeMain(run, "/repo")).toEqual({
      ok: true,
      detail: "merged origin/main",
    });
    expect(calls[0]).toEqual([
      "git",
      "-C",
      "/repo",
      "merge",
      "--no-edit",
      "origin/main",
    ]);
  });

  it("surfaces merge failures", async () => {
    const run = fakeRun(() => fail(1, "conflict"));
    expect(await mergeMain(run, "/repo")).toEqual({
      ok: false,
      detail: "conflict",
    });
  });
});

describe("abortMerge", () => {
  it("aborts the in-progress merge", async () => {
    const calls: string[][] = [];
    const run = fakeRun((command, args) => {
      calls.push([command, ...args]);
      return ok();
    });
    await abortMerge(run, "/repo");
    expect(calls[0]).toEqual(["git", "-C", "/repo", "merge", "--abort"]);
  });
});

describe("changedFiles", () => {
  const runFor = (changed: string[] | null) =>
    fakeRun((_command, args) => {
      if (changed === null) return fail(1, "bad object");
      return args.includes("--name-only")
        ? ok(`${changed.join("\n")}\n`)
        : undefined;
    });

  it("lists the changed paths", async () => {
    expect(
      await changedFiles(
        runFor(["pnpm-lock.yaml", "apps/web/x.ts"]),
        "/repo",
        "abc",
      ),
    ).toEqual(["pnpm-lock.yaml", "apps/web/x.ts"]);
  });

  it("returns null without a base commit", async () => {
    expect(
      await changedFiles(runFor(["pnpm-lock.yaml"]), "/repo", null),
    ).toBeNull();
  });

  it("returns null when the diff fails", async () => {
    expect(await changedFiles(runFor(null), "/repo", "abc")).toBeNull();
  });
});

describe("dependencyFilesChanged", () => {
  it("detects the root lockfile", () => {
    expect(dependencyFilesChanged(["pnpm-lock.yaml"])).toBe(true);
  });

  it("detects a workspace package.json", () => {
    expect(dependencyFilesChanged(["apps/web/package.json"])).toBe(true);
  });

  it("ignores unrelated changes", () => {
    expect(dependencyFilesChanged(["apps/web/src/x.ts"])).toBe(false);
  });

  it("reports nothing changed without a diff", () => {
    expect(dependencyFilesChanged(null)).toBe(false);
  });
});
