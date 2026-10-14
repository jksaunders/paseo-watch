import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./files.ts";

const commitStateSchema = z.object({
  state: z.enum(["passed", "failed", "pending", "none"]),
  checkedAt: z.string(),
  /**
   * The pull request the verdict belongs to. A pass is only trusted against the
   * PR it was recorded for; a verdict cached before a PR existed has none and is
   * re-evaluated once one appears.
   */
  pull: z.number().nullable().default(null),
});

const qualityRunSchema = z.object({
  phase: z.enum(["simplify", "review"]),
  agentId: z.string().default(""),
  startedAt: z.string(),
  observedRunning: z.boolean().default(false),
});

const stateSchema = z.object({
  eventsPrompted: z.record(z.string(), z.string()).default({}),
  commits: z.record(z.string(), commitStateSchema).default({}),
  quality: z.record(z.string(), qualityRunSchema).default({}),
  /** cwd -> when the workspace was queued for a dependency install. */
  installs: z.record(z.string(), z.string()).default({}),
});

export type CommitState = z.infer<typeof commitStateSchema>["state"];

export type QualityRun = z.infer<typeof qualityRunSchema>;

export type WatchState = z.infer<typeof stateSchema>;

export const emptyState = (): WatchState => ({
  eventsPrompted: {},
  commits: {},
  quality: {},
  installs: {},
});

export const parseState = (json: string | null): WatchState => {
  if (json === null) return emptyState();
  try {
    return stateSchema.parse(JSON.parse(json));
  } catch {
    return emptyState();
  }
};

export const serializeState = (state: WatchState): string =>
  `${JSON.stringify(state, null, 2)}\n`;

export const isPrompted = (state: WatchState, eventKey: string): boolean =>
  Object.hasOwn(state.eventsPrompted, eventKey);

export const markPrompted = (
  state: WatchState,
  eventKey: string,
  at: string,
): void => {
  state.eventsPrompted[eventKey] = at;
};

export const unpromptedEvents = <
  T extends { eventKey?: string; status: string },
>(
  results: T[],
  state: WatchState,
): T[] =>
  results.filter(
    (result) =>
      result.status === "action" &&
      result.eventKey !== undefined &&
      !isPrompted(state, result.eventKey),
  );

/**
 * A commit whose status checks have all passed is never examined again, so a
 * long-lived daemon stops paying for `gh` calls on settled work. A pass is only
 * trusted for the pull request it was recorded against; a verdict cached before
 * a PR existed is re-evaluated once one appears.
 */
export const isCommitPassed = (
  state: WatchState,
  sha: string,
  pull: number | null,
): boolean => {
  const commit = state.commits[sha];
  return commit?.state === "passed" && pull !== null && commit.pull === pull;
};

export const recordCommit = (
  state: WatchState,
  sha: string,
  commitState: CommitState,
  at: number,
  pull: number | null = null,
): void => {
  state.commits[sha] = {
    state: commitState,
    checkedAt: new Date(at).toISOString(),
    pull,
  };
};

export const pruneState = (
  state: WatchState,
  nowMs: number,
  maxAgeMs: number,
): void => {
  const isStale = (at: string): boolean => {
    const timestamp = Date.parse(at);
    return Number.isFinite(timestamp) && nowMs - timestamp > maxAgeMs;
  };

  for (const [key, at] of Object.entries(state.eventsPrompted)) {
    if (isStale(at)) delete state.eventsPrompted[key];
  }
  for (const [sha, commit] of Object.entries(state.commits)) {
    if (isStale(commit.checkedAt)) delete state.commits[sha];
  }
  for (const [workspaceId, run] of Object.entries(state.quality)) {
    if (isStale(run.startedAt)) delete state.quality[workspaceId];
  }
  for (const [cwd, at] of Object.entries(state.installs)) {
    if (isStale(at)) delete state.installs[cwd];
  }
};

export const loadState = async (path: string): Promise<WatchState> => {
  try {
    return parseState(await readFile(path, "utf8"));
  } catch {
    return emptyState();
  }
};

export const saveState = async (
  path: string,
  state: WatchState,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, serializeState(state));
};
