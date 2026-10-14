import { z } from "zod";
import type { Run } from "./types.ts";

const statusSchema = z.object({
  context: z.string(),
  state: z.string(),
  description: z
    .string()
    .nullish()
    .transform((value) => value ?? ""),
  target_url: z
    .string()
    .nullish()
    .transform((value) => value ?? ""),
});

const combinedSchema = z.object({
  state: z.string(),
  sha: z.string(),
  statuses: z.array(statusSchema),
});

type CommitStatusEntry = {
  context: string;
  state: string;
  description: string;
  targetUrl: string;
};

type CombinedStatus = {
  state: string;
  sha: string;
  statuses: CommitStatusEntry[];
};

export type StatusOutcome =
  | { kind: "status"; status: CombinedStatus }
  | { kind: "error"; detail: string };

const pullRequestSchema = z.object({
  number: z.number(),
  url: z.string(),
  body: z.string(),
});

export type PullRequest = z.infer<typeof pullRequestSchema>;

export type PullOutcome =
  | { kind: "found"; pull: PullRequest }
  | { kind: "none" }
  | { kind: "error"; detail: string };

export type PullUnavailable = Exclude<PullOutcome, { kind: "found" }>;

const NO_PULL_REQUEST = /no pull requests found/i;

export const fetchPullRequest = async (
  run: Run,
  cwd: string,
): Promise<PullOutcome> => {
  const result = await run("gh", ["pr", "view", "--json", "number,url,body"], {
    cwd,
  });

  if (result.code !== 0) {
    if (NO_PULL_REQUEST.test(result.stderr)) return { kind: "none" };
    return {
      kind: "error",
      detail: result.stderr.trim() || `gh exited ${result.code}`,
    };
  }

  try {
    return {
      kind: "found",
      pull: pullRequestSchema.parse(JSON.parse(result.stdout)),
    };
  } catch {
    return { kind: "error", detail: "Could not parse gh output" };
  }
};

const FAILED_STATES = new Set(["failure", "error"]);

export const isFailedState = (state: string): boolean =>
  FAILED_STATES.has(state);

export const isPendingState = (state: string): boolean => state === "pending";

export const fetchCombinedStatus = async (
  run: Run,
  repo: string,
  sha: string,
): Promise<StatusOutcome> => {
  const result = await run("gh", [
    "api",
    `repos/${repo}/commits/${sha}/status`,
  ]);

  if (result.code !== 0) {
    return {
      kind: "error",
      detail: result.stderr.trim() || `gh exited ${result.code}`,
    };
  }

  try {
    const parsed = combinedSchema.parse(JSON.parse(result.stdout));
    return {
      kind: "status",
      status: {
        state: parsed.state,
        sha: parsed.sha,
        statuses: parsed.statuses.map((entry) => ({
          context: entry.context,
          state: entry.state,
          description: entry.description,
          targetUrl: entry.target_url,
        })),
      },
    };
  } catch {
    return { kind: "error", detail: "Could not parse gh output" };
  }
};
