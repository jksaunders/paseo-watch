import {
  abortMerge,
  changedFiles,
  dependencyFilesChanged,
  MAIN_BRANCH,
  mainAlreadyMerged,
  mergeMain,
  mergeTreeConflicts,
  pushBranch,
  readBranchState,
  sharesMergeBase,
} from "../git.ts";
import { installNow, runQueuedInstall } from "../install.ts";
import type { Check, CheckContext, CheckDecision } from "../types.ts";
import { result } from "./result.ts";

const evaluate = async (
  cwd: string,
  context: CheckContext,
): Promise<CheckDecision> => {
  const state = await readBranchState(context.run, cwd);

  if (state.branch === null || state.branch === MAIN_BRANCH) {
    return { status: "skip", detail: "not on main", label: "n/a" };
  }
  if (state.headSha === null) {
    return { status: "skip", detail: "no commit", label: "n/a" };
  }
  if (!state.clean) {
    return { status: "skip", detail: "uncommitted changes", label: "dirty" };
  }
  if (context.runningCwds.has(cwd)) {
    return { status: "skip", detail: "agent running", label: "busy" };
  }
  if (await mainAlreadyMerged(context.run, cwd)) {
    const queued = await runQueuedInstall(context, cwd);
    if (queued) return queued;
    return { status: "ok", detail: "already up to date", label: "up to date" };
  }
  if (!(await sharesMergeBase(context.run, cwd))) {
    return {
      status: "skip",
      detail: "no merge base with origin/main",
      label: "n/a",
    };
  }

  const outcome = await mergeTreeConflicts(context.run, cwd);
  if (outcome.kind === "error") {
    return { status: "error", detail: outcome.detail, label: "error" };
  }

  if (outcome.kind === "conflict") {
    return {
      status: "action",
      detail: "main conflicts with this branch",
      label: "conflict",
      eventKey: `merge-main:${state.headSha}`,
      eventKind: "merge-main",
    };
  }

  if (context.config.dryRun) {
    return { status: "action", detail: "would merge main", label: "merged" };
  }

  const merged = await mergeMain(context.run, cwd);
  if (!merged.ok) {
    // A merge failure is a conflict the merge-tree probe missed (the branches
    // moved underneath us), so roll back and hand it to an agent now rather
    // than waiting a tick for a fresh probe.
    await abortMerge(context.run, cwd);
    return {
      status: "action",
      detail: `main conflicts with this branch — ${merged.detail}`,
      label: "conflict",
      eventKey: `merge-main:${state.headSha}`,
      eventKind: "merge-main",
    };
  }

  const pushed = await pushBranch(
    context.run,
    cwd,
    state.branch,
    state.hasUpstream,
  );
  if (!pushed.ok) {
    return { status: "error", detail: pushed.detail, label: "error" };
  }

  const changed = await changedFiles(context.run, cwd, state.headSha);
  if (!dependencyFilesChanged(changed)) {
    return {
      status: "action",
      detail: "merged and pushed main",
      label: "merged",
    };
  }

  const install = await installNow(context, cwd);
  if (!install.ok) {
    return {
      status: "error",
      detail: `merged and pushed main; install failed — ${install.detail}`,
      label: "install failed",
    };
  }
  return {
    status: "action",
    detail: "merged, pushed, and installed dependencies",
    label: "merged",
  };
};

export const createMergeMainCheck = (): Check => {
  // Workspaces sharing one cwd would race each other's `git merge`, mutating git
  // state (the index lock); share one outcome per cwd instead. Reset every tick
  // in targets.
  const inflight = new Map<string, Promise<CheckDecision>>();

  return {
    name: "Merge main",
    column: "merge main",
    targets: async (context) => {
      inflight.clear();
      return context.workspaces;
    },
    run: async (workspace, context) => {
      let decision = inflight.get(workspace.cwd);
      if (decision === undefined) {
        decision = evaluate(workspace.cwd, context);
        inflight.set(workspace.cwd, decision);
      }
      const resolved = await decision;
      return result(
        workspace,
        resolved.status,
        resolved.detail,
        resolved.label,
        { eventKey: resolved.eventKey, eventKind: resolved.eventKind },
      );
    },
  };
};
