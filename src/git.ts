import { dirname } from "node:path";
import type { Run } from "./types.ts";

export const MAIN_BRANCH = "main";

export type BranchState = {
  branch: string | null;
  headSha: string | null;
  clean: boolean;
  tipSeconds: number | null;
  unpushed: number;
  hasUpstream: boolean;
};

export type PushDecision =
  | { kind: "push"; reason: string }
  | { kind: "would-push"; reason: string }
  | {
      kind: "skip";
      reason: string;
      /** Whole ticks left before the debounce window closes, at least 1. */
      ticksRemaining?: number;
    };

const git = (run: Run, cwd: string, args: string[]) =>
  run("git", ["-C", cwd, ...args]);

export const refreshRemotes = async (run: Run, cwd: string): Promise<void> => {
  const common = await git(run, cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const base = dirname(common.stdout.trim());
  await run("git", ["-C", base, "fetch", "origin"]);
};

export const readBranchState = async (
  run: Run,
  cwd: string,
): Promise<BranchState> => {
  const [
    branchResult,
    statusResult,
    tipResult,
    upstreamResult,
    unpushedResult,
    shaResult,
  ] = await Promise.all([
    git(run, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(run, cwd, ["status", "--porcelain"]),
    git(run, cwd, ["log", "-1", "--format=%ct"]),
    git(run, cwd, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{u}",
    ]),
    git(run, cwd, ["rev-list", "--count", "HEAD", "--not", "--remotes"]),
    git(run, cwd, ["rev-parse", "HEAD"]),
  ]);

  const branchName = branchResult.stdout.trim();
  const tip = Number(tipResult.stdout.trim());

  return {
    branch:
      branchResult.code === 0 && branchName !== "HEAD" ? branchName : null,
    headSha: shaResult.code === 0 ? shaResult.stdout.trim() : null,
    clean: statusResult.stdout.trim() === "",
    tipSeconds: Number.isFinite(tip) && tip > 0 ? tip : null,
    unpushed: Number(unpushedResult.stdout.trim()) || 0,
    hasUpstream: upstreamResult.code === 0,
  };
};

export const decidePush = ({
  branch,
  clean,
  tipSeconds,
  unpushed,
  agentRunning,
  debounceSeconds,
  intervalSeconds,
  nowSeconds,
  dryRun,
}: {
  branch: string | null;
  clean: boolean;
  tipSeconds: number | null;
  unpushed: number;
  agentRunning: boolean;
  debounceSeconds: number;
  intervalSeconds: number;
  nowSeconds: number;
  dryRun: boolean;
}): PushDecision => {
  if (branch === null) return { kind: "skip", reason: "detached HEAD" };
  if (branch === MAIN_BRANCH) return { kind: "skip", reason: "on main" };
  if (unpushed === 0) return { kind: "skip", reason: "nothing to push" };
  if (!clean) return { kind: "skip", reason: "uncommitted changes" };
  if (agentRunning) return { kind: "skip", reason: "agent running" };

  if (tipSeconds !== null) {
    const age = nowSeconds - tipSeconds;
    if (age < debounceSeconds) {
      const wait = Math.ceil(debounceSeconds - age);
      const ticksRemaining = Math.max(
        1,
        Math.ceil((debounceSeconds - age) / intervalSeconds),
      );
      return {
        kind: "skip",
        reason: `waiting ${wait}s for the tip to settle`,
        ticksRemaining,
      };
    }
  }

  const commits = `${unpushed} commit${unpushed === 1 ? "" : "s"}`;
  if (dryRun) return { kind: "would-push", reason: `would push ${commits}` };
  return { kind: "push", reason: `pushed ${commits}` };
};

const MERGE_TARGET = `origin/${MAIN_BRANCH}`;

export type MergeTreeOutcome =
  | { kind: "clean" }
  | { kind: "conflict" }
  | { kind: "error"; detail: string };

export const sharesMergeBase = async (
  run: Run,
  cwd: string,
): Promise<boolean> => {
  const result = await git(run, cwd, ["merge-base", "HEAD", MERGE_TARGET]);
  return result.code === 0 && result.stdout.trim() !== "";
};

export const mainAlreadyMerged = async (
  run: Run,
  cwd: string,
): Promise<boolean> =>
  (await git(run, cwd, ["merge-base", "--is-ancestor", MERGE_TARGET, "HEAD"]))
    .code === 0;

export const mergeTreeConflicts = async (
  run: Run,
  cwd: string,
): Promise<MergeTreeOutcome> => {
  const result = await git(run, cwd, [
    "merge-tree",
    "--write-tree",
    "HEAD",
    MERGE_TARGET,
  ]);
  if (result.code === 0) return { kind: "clean" };
  if (result.code === 1) return { kind: "conflict" };
  return {
    kind: "error",
    detail: result.stderr.trim() || `git merge-tree exited ${result.code}`,
  };
};

export const mergeMain = async (
  run: Run,
  cwd: string,
): Promise<{ ok: boolean; detail: string }> => {
  const result = await git(run, cwd, ["merge", "--no-edit", MERGE_TARGET]);
  if (result.code !== 0) {
    return {
      ok: false,
      detail: result.stderr.trim() || `git merge exited ${result.code}`,
    };
  }
  return { ok: true, detail: result.stdout.trim() || `merged ${MERGE_TARGET}` };
};

/** Best-effort rollback so a failed merge never leaves a conflicted worktree. */
export const abortMerge = async (run: Run, cwd: string): Promise<void> => {
  await git(run, cwd, ["merge", "--abort"]);
};

/** Paths changed between `beforeSha` and HEAD, or null when git can't tell. */
export const changedFiles = async (
  run: Run,
  cwd: string,
  beforeSha: string | null,
): Promise<string[] | null> => {
  if (beforeSha === null) return null;
  const diff = await git(run, cwd, ["diff", "--name-only", beforeSha, "HEAD"]);
  if (diff.code !== 0) return null;
  return diff.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
};

const isDependencyFile = (path: string): boolean =>
  path === "pnpm-lock.yaml" ||
  path === "pnpm-workspace.yaml" ||
  path === "package.json" ||
  path.endsWith("/package.json");

/**
 * Whether changed paths can change the resolved dependency graph. The lockfile
 * is the precise signal; workspace membership and package manifests are included
 * so a stale install is never missed.
 */
export const dependencyFilesChanged = (paths: string[] | null): boolean =>
  paths?.some(isDependencyFile) ?? false;

export const commitsBehind = async (run: Run, cwd: string): Promise<number> => {
  const result = await run("git", [
    "-C",
    cwd,
    "rev-list",
    "--count",
    "HEAD..@{u}",
  ]);
  return result.code === 0 ? Number(result.stdout.trim()) || 0 : 0;
};

export const pushBranch = async (
  run: Run,
  cwd: string,
  branch: string,
  hasUpstream: boolean,
): Promise<{ ok: boolean; detail: string }> => {
  const args = hasUpstream
    ? ["-C", cwd, "push"]
    : ["-C", cwd, "push", "-u", "origin", branch];
  const result = await run("git", args);
  if (result.code !== 0) {
    return {
      ok: false,
      detail: result.stderr.trim() || `git push exited ${result.code}`,
    };
  }
  return { ok: true, detail: result.stderr.trim() || "pushed" };
};
