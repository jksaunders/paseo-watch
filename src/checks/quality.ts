import { type StartAgentOutcome, startWorkspaceAgent } from "../agent.ts";
import { READY_LABEL, removeWorkspaceLabel } from "../labels.ts";
import type { QualityRun } from "../state.ts";
import type { Check, CheckContext, Workspace } from "../types.ts";
import { result } from "./result.ts";

/**
 * A just-started agent can take a tick or two to appear in the running list, so
 * a phase only advances on an observed run→idle transition, or once this much
 * time has passed since it started.
 */
const MIN_ELAPSED_MS = 90_000;

type Phase = QualityRun["phase"];

/**
 * The agent we started is tracked by id so unrelated agents in the same
 * worktree cannot advance the run; cwd is a fallback when no id was returned.
 */
const isAgentRunning = (
  context: CheckContext,
  workspace: Workspace,
  entry: QualityRun,
): boolean =>
  entry.agentId === ""
    ? context.runningCwds.has(workspace.cwd)
    : context.runningAgentIds.has(entry.agentId);

const startPhase = (
  context: CheckContext,
  workspace: Workspace,
  phase: Phase,
): Promise<StartAgentOutcome> =>
  phase === "simplify"
    ? startWorkspaceAgent(context.run, {
        paseoCli: context.config.paseoCli,
        provider: context.config.provider,
        workspaceId: workspace.id,
        workspaceCwd: workspace.cwd,
        title: `Simplify: ${workspace.name}`,
        prompt: "/simplify",
      })
    : startWorkspaceAgent(context.run, {
        paseoCli: context.config.paseoCli,
        provider: context.config.provider,
        workspaceId: workspace.id,
        workspaceCwd: workspace.cwd,
        title: `Code review: ${workspace.name}`,
        prompt: "Do a code review of your work.",
      });

export const createQualityCheck = (): Check => ({
  name: "Quality",
  column: "quality",
  targets: async (context) =>
    context.workspaces.filter(
      (workspace) =>
        workspace.labels.includes(READY_LABEL) ||
        context.state.quality[workspace.id] !== undefined,
    ),
  run: async (workspace, context) => {
    const entry = context.state.quality[workspace.id];
    const hasLabel = workspace.labels.includes(READY_LABEL);

    if (!hasLabel) {
      if (entry) {
        delete context.state.quality[workspace.id];
        return result(
          workspace,
          "action",
          "quality label removed; run cancelled",
          "cancelled",
        );
      }
      return result(workspace, "skip", "no quality label", "n/a");
    }

    if (!entry) {
      if (context.runningCwds.has(workspace.cwd)) {
        return result(workspace, "skip", "agent already running", "busy");
      }
      if (context.config.dryRun) {
        return result(workspace, "action", "would start /simplify", "simplify");
      }

      const started = await startPhase(context, workspace, "simplify");
      if (!started.ok) {
        return result(workspace, "error", started.detail, "error");
      }
      context.state.quality[workspace.id] = {
        phase: "simplify",
        agentId: started.agentId ?? "",
        startedAt: new Date(context.now()).toISOString(),
        observedRunning: false,
      };
      return result(workspace, "action", "started /simplify", "simplify");
    }

    if (isAgentRunning(context, workspace, entry)) {
      entry.observedRunning = true;
      return result(
        workspace,
        "skip",
        `${entry.phase} agent running`,
        entry.phase === "simplify" ? "simplifying" : "reviewing",
      );
    }

    const elapsed = context.now() - Date.parse(entry.startedAt);
    if (!entry.observedRunning && elapsed < MIN_ELAPSED_MS) {
      return result(
        workspace,
        "skip",
        "waiting for the agent to start",
        entry.phase,
      );
    }

    if (entry.phase === "simplify") {
      if (context.config.dryRun) {
        return result(
          workspace,
          "action",
          "would start a code review",
          "review",
        );
      }

      const started = await startPhase(context, workspace, "review");
      if (!started.ok) {
        return result(workspace, "error", started.detail, "error");
      }
      entry.phase = "review";
      entry.agentId = started.agentId ?? "";
      entry.startedAt = new Date(context.now()).toISOString();
      entry.observedRunning = false;
      return result(workspace, "action", "started a code review", "review");
    }

    if (context.config.dryRun) {
      return result(workspace, "action", "would remove the label", "done");
    }

    const removed = await removeWorkspaceLabel(
      context.config,
      workspace.id,
      READY_LABEL,
    );
    if (!removed.ok) {
      return result(workspace, "error", removed.detail, "error");
    }
    delete context.state.quality[workspace.id];
    workspace.labels = workspace.labels.filter(
      (label) => label !== READY_LABEL,
    );
    return result(
      workspace,
      "action",
      "quality finished; label removed",
      "done",
    );
  },
});
