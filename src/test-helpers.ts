import { vi } from "vitest";
import { DEFAULT_REPO } from "./config.ts";
import { PROJECT_IDENTIFIER } from "./plane.ts";
import { emptyState } from "./state.ts";
import type {
  CheckContext,
  Config,
  Run,
  RunResult,
  Workspace,
} from "./types.ts";

export const ok = (stdout = ""): RunResult => ({
  stdout,
  stderr: "",
  code: 0,
});

export const fail = (code = 1, stderr = ""): RunResult => ({
  stdout: "",
  stderr,
  code,
});

export type RunHandler = (
  command: string,
  args: string[],
) => RunResult | undefined;

export const fakeRun =
  (handler: RunHandler): Run =>
  async (command, args) => {
    const result = handler(command, args);
    if (!result) {
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    }
    return result;
  };

export const testConfig = (overrides: Partial<Config> = {}): Config => ({
  intervalSeconds: 60,
  debounceSeconds: 120,
  dryRun: false,
  verbose: false,
  repo: DEFAULT_REPO,
  circleciProject: `gh/${DEFAULT_REPO}`,
  paseoHome: "/home/u/.paseo",
  paseoCli: "paseo",
  provider: "",
  planeApiKey: "",
  statePath: "/home/u/.paseo/runtime/paseo-watch/state.json",
  skipLabels: ["skip-updates"],
  ...overrides,
});

export const workspace = (overrides: Partial<Workspace> = {}): Workspace => ({
  id: "wks_1",
  name: `${PROJECT_IDENTIFIER}-1: Example`,
  cwd: "/repo/worktree",
  labels: [],
  ...overrides,
});

export const testContext = (
  overrides: Partial<CheckContext> = {},
): CheckContext => ({
  config: testConfig(),
  workspaces: [],
  runningCwds: new Set(),
  runningAgentIds: new Set(),
  run: vi.fn() as unknown as Run,
  state: emptyState(),
  now: () => 1_000_000_000_000,
  ...overrides,
});

export const stubPlane = (opts: {
  stateName?: string;
  links?: string[];
  fail?: boolean;
}): void => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (opts.fail) {
        return { ok: false, status: 500, text: async () => "boom" };
      }
      const path = new URL(url).pathname;
      if (path.endsWith("/links/")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              results: (opts.links ?? []).map((url) => ({ url })),
            }),
        };
      }
      if (path.includes("/work-items/")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ results: [{ id: "item1", state: "state1" }] }),
        };
      }
      if (path.endsWith("/states/")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              results: [
                { id: "state1", name: opts.stateName ?? "Needs Review" },
              ],
            }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            results: [{ id: "proj1", identifier: PROJECT_IDENTIFIER }],
          }),
      };
    }),
  );
};
