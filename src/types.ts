import type { WatchState } from "./state.ts";

export type CheckStatus = "ok" | "action" | "skip" | "error";

export type CheckResult = {
  target: string;
  status: CheckStatus;
  detail: string;
  /** Short cell label for the dashboard, e.g. "pushed", "busy", "no runs". */
  label?: string;
  workspaceId?: string;
  /**
   * Identifies the underlying event so the daemon prompts about it once rather
   * than every tick. Absent for results that never prompt.
   */
  eventKey?: string;
  /** What kind of failure to prompt about, so the started agent gets the right brief. */
  eventKind?:
    | "circleci"
    | "status"
    | "needs-review"
    | "merge-when-ready"
    | "merge-main";
  /** Sticky dashboard footer note, e.g. a restart hint. */
  notice?: string;
};

export type ResultExtras = {
  eventKey?: string;
  eventKind?: CheckResult["eventKind"];
  notice?: string;
};

export type CheckDecision = {
  status: CheckStatus;
  detail: string;
  label: string;
} & ResultExtras;

export type Workspace = {
  id: string;
  name: string;
  cwd: string;
  labels: string[];
};

export type RunResult = {
  stdout: string;
  stderr: string;
  code: number;
};

type RunOptions = {
  cwd?: string;
};

export type Run = (
  command: string,
  args: string[],
  options?: RunOptions,
) => Promise<RunResult>;

export type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug: (message: string) => void;
};

export type Config = {
  intervalSeconds: number;
  debounceSeconds: number;
  dryRun: boolean;
  verbose: boolean;
  repo: string;
  circleciProject: string;
  paseoHome: string;
  paseoCli: string;
  provider: string;
  planeApiKey: string;
  statePath: string;
  skipLabels: string[];
};

export type CheckContext = {
  config: Config;
  workspaces: Workspace[];
  runningCwds: Set<string>;
  runningAgentIds: Set<string>;
  run: Run;
  state: WatchState;
  now: () => number;
};

export type Check = {
  name: string;
  /** Short name for the dashboard column header, e.g. "push". */
  column: string;
  targets: (context: CheckContext) => Promise<Workspace[]>;
  run: (target: Workspace, context: CheckContext) => Promise<CheckResult>;
};

export type GlobalCheckResult = {
  status: CheckStatus;
  /** Long form, shown under the row when notable. */
  detail: string;
  /** Short cell text, e.g. "Operational" or the providers with incidents. */
  label?: string;
};

export type GlobalCheck = {
  name: string;
  run: (context: CheckContext) => Promise<GlobalCheckResult>;
};

export type TickResults = {
  workspaces: CheckResult[];
  global: GlobalCheckResult[];
};
