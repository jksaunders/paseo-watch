import {
  changedFiles,
  commitsBehind,
  dependencyFilesChanged,
  MAIN_BRANCH,
  readBranchState,
} from "../git.ts";
import { installNow, runQueuedInstall } from "../install.ts";
import { restartNotice } from "../self.ts";
import type { Check, CheckContext, CheckDecision } from "../types.ts";
import { result } from "./result.ts";

const commitCount = (count: number): string =>
  `${count} commit${count === 1 ? "" : "s"}`;

const evaluate = async (
  cwd: string,
  context: CheckContext,
): Promise<CheckDecision> => {
  const state = await readBranchState(context.run, cwd);

  if (state.branch !== MAIN_BRANCH) {
    return { status: "skip", detail: "not on main", label: "n/a" };
  }
  if (!state.clean) {
    return {
      status: "skip",
      detail: "uncommitted changes",
      label: "dirty",
    };
  }
  if (!state.hasUpstream) {
    return {
      status: "skip",
      detail: "main has no upstream",
      label: "no upstream",
    };
  }

  const behind = await commitsBehind(context.run, cwd);
  if (behind === 0) {
    const queued = await runQueuedInstall(context, cwd);
    if (queued) return queued;
    return { status: "ok", detail: "already up to date", label: "up to date" };
  }
  if (context.config.dryRun) {
    return {
      status: "action",
      detail: `would pull ${commitCount(behind)}`,
      label: "to pull",
    };
  }

  const pull = await context.run("git", ["-C", cwd, "pull", "--ff-only"]);
  if (pull.code !== 0) {
    return {
      status: "error",
      detail: pull.stderr.trim() || `git pull exited ${pull.code}`,
      label: "error",
    };
  }
  const changed = await changedFiles(context.run, cwd, state.headSha);
  const notice = await restartNotice(context.run, cwd, changed);

  if (!dependencyFilesChanged(changed)) {
    return {
      status: "action",
      detail: `pulled ${commitCount(behind)}`,
      label: "pulled",
      notice,
    };
  }

  const install = await installNow(context, cwd);
  if (!install.ok) {
    return {
      status: "error",
      detail: `pulled ${commitCount(behind)}; install failed — ${install.detail}`,
      label: "install failed",
      notice,
    };
  }
  return {
    status: "action",
    detail: `pulled ${commitCount(behind)}; installed dependencies`,
    label: "pulled",
    notice,
  };
};

export const createPullCheck = (): Check => {
  // Workspaces sharing one cwd race each other's `git pull`, mutating git state
  // (FETCH_HEAD, the index lock); share one outcome per cwd instead. Reset every
  // tick in targets.
  const inflight = new Map<string, Promise<CheckDecision>>();

  return {
    name: "Pull main",
    column: "pull",
    targets: async (context) => {
      inflight.clear();
      return context.workspaces;
    },
    run: async (workspace, context) => {
      let pull = inflight.get(workspace.cwd);
      if (pull === undefined) {
        pull = evaluate(workspace.cwd, context);
        inflight.set(workspace.cwd, pull);
      }
      const decision = await pull;
      return result(
        workspace,
        decision.status,
        decision.detail,
        decision.label,
        { notice: decision.notice },
      );
    },
  };
};
