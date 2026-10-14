import { z } from "zod";
import type { Workspace } from "./types.ts";

const workspaceListSchema = z.array(
  z.object({
    workspaceId: z.string(),
    project: z.string(),
    name: z.string(),
    cwd: z.string(),
  }),
);

const agentListSchema = z.array(
  z.object({
    id: z.string(),
    cwd: z.string(),
    status: z.string(),
    provider: z.string().optional(),
    thinking: z.string().optional(),
  }),
);

const workspaceStateSchema = z.array(
  z.object({
    workspaceId: z.string(),
    labels: z.array(z.string()).optional(),
    archivedAt: z.string().nullable().optional(),
  }),
);

export type WorkspaceState = {
  labels: string[];
  archived: boolean;
};

export const expandHome = (value: string, home: string): string =>
  value.startsWith("~") ? `${home}${value.slice(1)}` : value;

export const workspaceStatePath = (paseoHome: string): string =>
  `${paseoHome}/projects/workspaces.json`;

export const parseWorkspaceList = (
  json: string,
  repo: string,
  home: string,
): Workspace[] =>
  workspaceListSchema
    .parse(JSON.parse(json))
    .filter((workspace) => workspace.project === repo)
    .map((workspace) => ({
      id: workspace.workspaceId,
      name: workspace.name,
      cwd: expandHome(workspace.cwd, home),
      labels: [],
    }));

export type RunningAgents = {
  cwds: Set<string>;
  ids: Set<string>;
};

export const parseRunningAgents = (
  json: string,
  home: string,
): RunningAgents => {
  const cwds = new Set<string>();
  const ids = new Set<string>();
  for (const agent of agentListSchema.parse(JSON.parse(json))) {
    if (agent.status !== "running") continue;
    cwds.add(expandHome(agent.cwd, home));
    ids.add(agent.id);
  }
  return { cwds, ids };
};

export type AgentSettings = { provider: string; thinking: string };

export const findAgentSettings = (
  json: string,
  cwd: string,
  home: string,
): AgentSettings | null => {
  for (const agent of agentListSchema.parse(JSON.parse(json))) {
    const provider = agent.provider ?? "";
    if (provider === "" || expandHome(agent.cwd, home) !== cwd) continue;
    return { provider, thinking: agent.thinking ?? "" };
  }
  return null;
};

export const parseWorkspaceState = (
  json: string,
): Map<string, WorkspaceState> => {
  const states = new Map<string, WorkspaceState>();
  for (const entry of workspaceStateSchema.parse(JSON.parse(json))) {
    states.set(entry.workspaceId, {
      labels: entry.labels ?? [],
      archived: Boolean(entry.archivedAt),
    });
  }
  return states;
};

export const selectWorkspaces = (
  workspaces: Workspace[],
  states: Map<string, WorkspaceState>,
  skipLabels: string[],
): Workspace[] =>
  workspaces
    .filter((workspace) => {
      const state = states.get(workspace.id);
      if (!state) return true;
      if (state.archived) return false;
      return !state.labels.some((label) => skipLabels.includes(label));
    })
    .map((workspace) => ({
      ...workspace,
      labels: states.get(workspace.id)?.labels ?? [],
    }));

const MAIN_WORKSPACE_NAME = "main";

/**
 * Every local workspace, including the project's `main`, points at the same
 * checkout, so one row per cwd is enough. Prefer the one named `main`.
 */
export const dedupeByCwd = (workspaces: Workspace[]): Workspace[] => {
  const byCwd = new Map<string, Workspace>();
  for (const workspace of workspaces) {
    if (workspace.name === MAIN_WORKSPACE_NAME || !byCwd.has(workspace.cwd)) {
      byCwd.set(workspace.cwd, workspace);
    }
  }
  return [...byCwd.values()];
};

export const findMainWorkspace = (
  workspaces: Workspace[],
): Workspace | undefined =>
  workspaces.find((workspace) => workspace.name === MAIN_WORKSPACE_NAME);

export const parseRemote = (url: string): string =>
  url
    .trim()
    .replace(/^(git@[^:]+:|https?:\/\/[^/]+\/)/, "")
    .replace(/\.git$/, "");
