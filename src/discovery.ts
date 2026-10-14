import { readFile as readFileNode } from "node:fs/promises";
import os from "node:os";
import type { Config, Run, Workspace } from "./types.ts";
import {
  dedupeByCwd,
  parseRunningAgents,
  parseWorkspaceList,
  parseWorkspaceState,
  type RunningAgents,
  selectWorkspaces,
  type WorkspaceState,
  workspaceStatePath,
} from "./workspaces.ts";

export type Discovery = {
  workspaces: Workspace[];
};

const readTextIfExists = async (path: string): Promise<string | null> => {
  try {
    return await readFileNode(path, "utf8");
  } catch {
    return null;
  }
};

export const discoverRunningAgents = async (
  config: Config,
  run: Run,
  home: string = os.homedir(),
): Promise<RunningAgents> => {
  const agentsResult = await run(config.paseoCli, ["ls", "--json"]);
  if (agentsResult.code !== 0) {
    throw new Error(
      `Could not list Paseo agents: ${agentsResult.stderr.trim() || `exit ${agentsResult.code}`}`,
    );
  }
  return parseRunningAgents(agentsResult.stdout, home);
};

export const discover = async (
  config: Config,
  run: Run,
  home: string = os.homedir(),
  readFile: (path: string) => Promise<string | null> = readTextIfExists,
): Promise<Discovery> => {
  const listResult = await run(config.paseoCli, ["workspace", "ls", "--json"]);
  if (listResult.code !== 0) {
    throw new Error(
      `Could not list Paseo workspaces: ${listResult.stderr.trim() || `exit ${listResult.code}`}`,
    );
  }

  const workspaces = parseWorkspaceList(listResult.stdout, config.repo, home);

  const stateJson = await readFile(workspaceStatePath(config.paseoHome));
  let states = new Map<string, WorkspaceState>();
  if (stateJson !== null) {
    try {
      states = parseWorkspaceState(stateJson);
    } catch {
      states = new Map();
    }
  }

  return {
    workspaces: dedupeByCwd(
      selectWorkspaces(workspaces, states, config.skipLabels),
    ),
  };
};
