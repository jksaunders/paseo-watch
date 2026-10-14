import { pruneState, type WatchState } from "./state.ts";
import type { CheckContext, TickResults, Workspace } from "./types.ts";
import type { RunningAgents } from "./workspaces.ts";

const MAX_SURFACED_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type TickDeps = {
  context: CheckContext;
  state: WatchState;
  runChecks: () => Promise<TickResults>;
  present: (results: TickResults) => Promise<void>;
  refresh?: () => Promise<void>;
  refreshWorkspaces?: () => Promise<Workspace[]>;
  refreshRunningAgents?: () => Promise<RunningAgents>;
  persist?: () => Promise<void>;
  now: () => Date;
};

export const runTick = async (deps: TickDeps): Promise<TickResults> => {
  if (deps.refresh) {
    try {
      await deps.refresh();
    } catch {
      // A failed fetch only makes "unpushed" detection staler, not wrong; keep ticking.
    }
  }
  if (deps.refreshWorkspaces) {
    try {
      // Labels and worktrees change while the daemon runs, so re-read them
      // every tick rather than trusting the startup snapshot.
      deps.context.workspaces = await deps.refreshWorkspaces();
    } catch {
      // A failed listing leaves the previous workspaces in place; keep ticking.
    }
  }
  if (deps.refreshRunningAgents) {
    try {
      const running = await deps.refreshRunningAgents();
      deps.context.runningCwds = running.cwds;
      deps.context.runningAgentIds = running.ids;
    } catch {
      // A failed listing leaves the previous busy/idle state in place; keep ticking.
    }
  }

  const results = await deps.runChecks();
  pruneState(deps.state, deps.now().getTime(), MAX_SURFACED_AGE_MS);
  await deps.present(results);
  if (deps.persist) await deps.persist();
  return results;
};
