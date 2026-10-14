import { fetchBranchFailureReport, isCircleciContext } from "../circleci.ts";
import { MAIN_BRANCH, readBranchState } from "../git.ts";
import {
  fetchCombinedStatus,
  fetchPullRequest,
  isFailedState,
  isPendingState,
} from "../github.ts";
import { recordCommit } from "../state.ts";
import type { Check } from "../types.ts";
import { pullUnavailableResult } from "./resolve-pull.ts";
import { result } from "./result.ts";

const describeStatuses = (
  entries: { context: string; description: string }[],
) =>
  entries
    .map((entry) =>
      entry.description
        ? `${entry.context}: ${entry.description}`
        : entry.context,
    )
    .join("; ");

export const createStatusCheck = (): Check => ({
  name: "Commit status checks",
  column: "status",
  targets: async (context) => context.workspaces,
  run: async (workspace, context) => {
    const branchState = await readBranchState(context.run, workspace.cwd);
    const { branch, headSha } = branchState;

    if (branch === null || branch === MAIN_BRANCH) {
      return result(workspace, "skip", "no branch to check", "n/a");
    }
    if (headSha === null) {
      return result(workspace, "skip", "no commit", "n/a");
    }
    if (branchState.unpushed > 0) {
      return result(
        workspace,
        "skip",
        "commit not pushed to remote",
        "not pushed",
      );
    }

    // A pass tied to a known PR is settled and needs no `gh` call. A pass
    // recorded before the branch had a PR has no PR to tie it to, so it is
    // re-evaluated once one exists.
    const cached = context.state.commits[headSha];
    if (cached?.state === "passed" && cached.pull !== null) {
      return result(workspace, "ok", "status checks passed", "passed");
    }

    // Until a PR exists there is nothing to resolve, and acting on pre-PR
    // statuses would prompt on work no reviewer has seen.
    const pull = await fetchPullRequest(context.run, workspace.cwd);
    if (pull.kind !== "found") {
      return pullUnavailableResult(workspace, pull);
    }
    const pullNumber = pull.pull.number;

    const outcome = await fetchCombinedStatus(
      context.run,
      context.config.repo,
      headSha,
    );
    if (outcome.kind === "error") {
      recordCommit(context.state, headSha, "failed", context.now());
      return result(workspace, "error", outcome.detail, "error");
    }

    const { status } = outcome;
    if (status.statuses.length === 0) {
      recordCommit(context.state, headSha, "none", context.now());
      return result(workspace, "skip", "no status checks", "no ci");
    }

    // GitHub's combined state reports "failure" as soon as any one status
    // fails, even while others are still running. Wait for every status to
    // finish so related checks surface as a single prompt.
    const running = status.statuses.filter((entry) =>
      isPendingState(entry.state),
    );
    if (running.length > 0) {
      recordCommit(context.state, headSha, "pending", context.now());
      return result(
        workspace,
        "skip",
        `${running.length} check(s) still running`,
        "pending",
      );
    }

    const failing = status.statuses.filter((entry) =>
      isFailedState(entry.state),
    );
    if (failing.length > 0) {
      recordCommit(context.state, headSha, "failed", context.now());
      const summary = describeStatuses(failing);

      if (failing.some((entry) => isCircleciContext(entry.context))) {
        const report = await fetchBranchFailureReport(
          context.run,
          context.config.circleciProject,
          branch,
        );
        return result(
          workspace,
          "action",
          report
            ? `CircleCI failure — ${summary}\n${report}`
            : `CircleCI failure — ${summary}`,
          "circleci",
          { eventKey: `status:${headSha}`, eventKind: "circleci" },
        );
      }

      return result(workspace, "action", summary, "failed", {
        eventKey: `status:${headSha}`,
        eventKind: "status",
      });
    }

    recordCommit(context.state, headSha, "passed", context.now(), pullNumber);
    return result(workspace, "ok", "status checks passed", "passed");
  },
});
