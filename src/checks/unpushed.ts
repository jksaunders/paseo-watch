import {
  decidePush,
  type PushDecision,
  pushBranch,
  readBranchState,
} from "../git.ts";
import type { Check } from "../types.ts";
import { result } from "./result.ts";

const REASON_LABELS: Record<string, string> = {
  "on main": "main",
  "nothing to push": "clean",
  "uncommitted changes": "dirty",
  "agent running": "busy",
  "detached HEAD": "detached",
};

const reasonLabel = (
  decision: Extract<PushDecision, { kind: "skip" }>,
): string => {
  if (decision.ticksRemaining !== undefined) {
    const ticks = decision.ticksRemaining;
    return `${ticks} tick${ticks === 1 ? "" : "s"}`;
  }
  return REASON_LABELS[decision.reason] ?? decision.reason;
};

export const createUnpushedCheck = (): Check => ({
  name: "Push unpushed commits",
  column: "push",
  targets: async (context) => context.workspaces,
  run: async (workspace, context) => {
    const state = await readBranchState(context.run, workspace.cwd);
    const branch = state.branch;

    const decision = decidePush({
      branch,
      clean: state.clean,
      tipSeconds: state.tipSeconds,
      unpushed: state.unpushed,
      agentRunning: context.runningCwds.has(workspace.cwd),
      debounceSeconds: context.config.debounceSeconds,
      intervalSeconds: context.config.intervalSeconds,
      nowSeconds: Math.floor(context.now() / 1000),
      dryRun: context.config.dryRun,
    });

    if (decision.kind === "skip") {
      return result(workspace, "skip", decision.reason, reasonLabel(decision));
    }
    if (decision.kind === "would-push" || branch === null) {
      return result(workspace, "action", decision.reason, "pushed");
    }

    const pushed = await pushBranch(
      context.run,
      workspace.cwd,
      branch,
      state.hasUpstream,
    );
    return pushed.ok
      ? result(workspace, "action", decision.reason, "pushed")
      : result(workspace, "error", pushed.detail, "error");
  },
});
