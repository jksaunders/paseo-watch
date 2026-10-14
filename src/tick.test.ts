import { describe, expect, it, vi } from "vitest";
import { emptyState } from "./state.ts";
import { testContext } from "./test-helpers.ts";
import { runTick, type TickDeps } from "./tick.ts";
import type { CheckResult, TickResults } from "./types.ts";
import type { RunningAgents } from "./workspaces.ts";

const result = (overrides: Partial<CheckResult> = {}): CheckResult => ({
  target: "TASK-1",
  status: "ok",
  detail: "fine",
  ...overrides,
});

const tickResults = (): TickResults => ({ workspaces: [result()], global: [] });

const deps = (overrides: Partial<TickDeps> = {}): TickDeps => ({
  context: testContext(),
  state: emptyState(),
  runChecks: vi.fn(async () => tickResults()),
  present: vi.fn(async () => {}),
  now: () => new Date("2020-01-01T00:00:00.000Z"),
  ...overrides,
});

describe("runTick", () => {
  it("runs checks, presents the results, then persists", async () => {
    const persist = vi.fn(async () => {});
    const present = vi.fn(async () => {});
    const runChecks = vi.fn(async () => tickResults());

    const results = await runTick(deps({ persist, present, runChecks }));

    expect(runChecks).toHaveBeenCalledOnce();
    expect(present).toHaveBeenCalledWith(results);
    expect(persist).toHaveBeenCalledOnce();
  });

  it("refreshes remotes first and keeps going when the fetch fails", async () => {
    const refresh = vi.fn(async () => {
      throw new Error("offline");
    });

    const results = await runTick(deps({ refresh }));

    expect(refresh).toHaveBeenCalledOnce();
    expect(results.workspaces).toHaveLength(1);
  });

  it("refreshes agent-running state before running checks", async () => {
    const context = testContext();
    const refreshRunningAgents = vi.fn(
      async (): Promise<RunningAgents> => ({
        cwds: new Set(["/busy"]),
        ids: new Set(["ag_1"]),
      }),
    );
    const runChecks = vi.fn(async () => tickResults());

    await runTick(deps({ context, refreshRunningAgents, runChecks }));

    expect(refreshRunningAgents).toHaveBeenCalledOnce();
    expect(runChecks).toHaveBeenCalledOnce();
    expect(context.runningCwds).toEqual(new Set(["/busy"]));
    expect(context.runningAgentIds).toEqual(new Set(["ag_1"]));
    expect(
      refreshRunningAgents.mock.invocationCallOrder[0] ?? Infinity,
    ).toBeLessThan(runChecks.mock.invocationCallOrder[0] ?? 0);
  });

  it("keeps the previous running state and keeps ticking when the refresh fails", async () => {
    const context = testContext({
      runningCwds: new Set(["/prior"]),
      runningAgentIds: new Set(["prior_ag"]),
    });
    const refreshRunningAgents = vi.fn(async (): Promise<RunningAgents> => {
      throw new Error("offline");
    });

    const results = await runTick(deps({ context, refreshRunningAgents }));

    expect(results.workspaces).toHaveLength(1);
    expect(context.runningCwds).toEqual(new Set(["/prior"]));
    expect(context.runningAgentIds).toEqual(new Set(["prior_ag"]));
  });

  it("re-reads workspaces before running checks", async () => {
    const context = testContext({ workspaces: [] });
    const fresh = [
      { id: "wks_1", name: "TASK-1: Example", cwd: "/repo", labels: ["x"] },
    ];
    const refreshWorkspaces = vi.fn(async () => fresh);
    const runChecks = vi.fn(async () => tickResults());

    await runTick(deps({ context, refreshWorkspaces, runChecks }));

    expect(refreshWorkspaces).toHaveBeenCalledOnce();
    expect(context.workspaces).toEqual(fresh);
    expect(
      refreshWorkspaces.mock.invocationCallOrder[0] ?? Infinity,
    ).toBeLessThan(runChecks.mock.invocationCallOrder[0] ?? 0);
  });

  it("keeps the previous workspaces and keeps ticking when the refresh fails", async () => {
    const prior = [
      { id: "wks_1", name: "TASK-1: Example", cwd: "/repo", labels: [] },
    ];
    const context = testContext({ workspaces: prior });
    const refreshWorkspaces = vi.fn(async () => {
      throw new Error("offline");
    });

    const results = await runTick(deps({ context, refreshWorkspaces }));

    expect(results.workspaces).toHaveLength(1);
    expect(context.workspaces).toEqual(prior);
  });

  it("prunes prompted events older than the retention window", async () => {
    const state = emptyState();
    state.eventsPrompted.stale = "2010-01-01T00:00:00.000Z";
    state.commits.old = {
      state: "passed",
      checkedAt: "2010-01-01T00:00:00.000Z",
      pull: null,
    };

    await runTick(deps({ state }));

    expect(Object.keys(state.eventsPrompted)).toEqual([]);
    expect(Object.keys(state.commits)).toEqual([]);
  });
});
