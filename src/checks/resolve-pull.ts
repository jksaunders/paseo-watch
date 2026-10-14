import { MAIN_BRANCH, readBranchState } from "../git.ts";
import {
  fetchPullRequest,
  type PullRequest,
  type PullUnavailable,
} from "../github.ts";
import { parseWorkItemRef } from "../plane.ts";
import type { CheckContext, CheckResult, Workspace } from "../types.ts";
import { result } from "./result.ts";

export type WorkspacePull =
  | { kind: "ready"; ref: string; headSha: string; pull: PullRequest }
  | { kind: "result"; result: CheckResult };

/**
 * The shared verdict for a pull request that is missing or could not be
 * fetched, so every PR-based check reports it the same way.
 */
export const pullUnavailableResult = (
  workspace: Workspace,
  pull: PullUnavailable,
): CheckResult => {
  if (pull.kind === "error") {
    return result(workspace, "error", pull.detail, "error");
  }
  return result(workspace, "skip", "no pull request", "no pr");
};

/**
 * The prefix every PR-based check shares: resolve the work item ref, skip busy
 * or branchless workspaces, and fetch the pull request under review.
 */
export const resolveWorkspacePull = async (
  workspace: Workspace,
  context: CheckContext,
): Promise<WorkspacePull> => {
  const ref = parseWorkItemRef(workspace.name);
  if (ref === null) {
    return {
      kind: "result",
      result: result(
        workspace,
        "skip",
        "no work item in workspace name",
        "n/a",
      ),
    };
  }
  if (context.runningCwds.has(workspace.cwd)) {
    return {
      kind: "result",
      result: result(workspace, "skip", "agent running", "busy"),
    };
  }

  const { branch, headSha } = await readBranchState(context.run, workspace.cwd);
  if (branch === null || branch === MAIN_BRANCH || headSha === null) {
    return {
      kind: "result",
      result: result(workspace, "skip", "no branch to check", "n/a"),
    };
  }

  const pull = await fetchPullRequest(context.run, workspace.cwd);
  if (pull.kind !== "found") {
    return {
      kind: "result",
      result: pullUnavailableResult(workspace, pull),
    };
  }

  return { kind: "ready", ref, headSha, pull: pull.pull };
};
