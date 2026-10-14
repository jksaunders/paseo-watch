import os from "node:os";
import type { Run } from "./types.ts";
import { type AgentSettings, findAgentSettings } from "./workspaces.ts";

export type StartAgentOptions = {
  paseoCli: string;
  provider: string;
  workspaceId: string;
  workspaceCwd?: string;
  home?: string;
  title: string;
  prompt: string;
};

export type StartAgentOutcome = {
  ok: boolean;
  detail: string;
  agentId?: string;
};

const parseAgentId = (json: string): string => {
  try {
    const parsed = JSON.parse(json) as {
      agentId?: unknown;
      agent?: { id?: unknown };
    };
    if (typeof parsed.agentId === "string") return parsed.agentId;
    if (typeof parsed.agent?.id === "string") return parsed.agent.id;
  } catch {
    // Fall through to an empty id; the caller falls back to cwd-based tracking.
  }
  return "";
};

/**
 * A standalone daemon has no PASEO_PROVIDER of its own, so fall back to the
 * provider and thinking level already in use by an agent in the same workspace.
 */
const resolveSettings = async (
  run: Run,
  options: StartAgentOptions,
): Promise<AgentSettings | null> => {
  if (options.workspaceCwd === undefined) return null;
  const listed = await run(options.paseoCli, ["ls", "--json"]);
  if (listed.code !== 0) return null;
  try {
    return findAgentSettings(
      listed.stdout,
      options.workspaceCwd,
      options.home ?? os.homedir(),
    );
  } catch {
    return null;
  }
};

export const startWorkspaceAgent = async (
  run: Run,
  options: StartAgentOptions,
): Promise<StartAgentOutcome> => {
  if (options.workspaceId === "") {
    return { ok: false, detail: "No workspace to start an agent in" };
  }

  const fallback =
    options.provider === "" ? await resolveSettings(run, options) : null;
  const provider = options.provider || fallback?.provider || "";
  if (provider === "") {
    return {
      ok: false,
      detail:
        "No provider is set and none was found in the workspace; cannot start an agent",
    };
  }
  const thinking = fallback?.thinking || "high";

  const result = await run(options.paseoCli, [
    "run",
    "--workspace",
    options.workspaceId,
    "--provider",
    provider,
    "--thinking",
    thinking,
    "--title",
    options.title,
    "--background",
    "--json",
    options.prompt,
  ]);

  if (result.code !== 0) {
    return {
      ok: false,
      detail: result.stderr.trim() || `paseo run exited ${result.code}`,
    };
  }
  return {
    ok: true,
    detail: `Started an agent for ${options.title}`,
    agentId: parseAgentId(result.stdout),
  };
};
