import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { READY_LABEL } from "../labels.ts";
import { emptyState, type QualityRun } from "../state.ts";
import {
  fail,
  fakeRun,
  ok,
  testConfig,
  testContext,
  workspace,
} from "../test-helpers.ts";
import type { CheckContext, Run, RunResult } from "../types.ts";
import { createQualityCheck } from "./quality.ts";

const START = 1_700_000_000_000;
const OLD_ENOUGH_MS = 120_000;

const entry = (overrides: Partial<QualityRun> = {}): QualityRun => ({
  phase: "simplify",
  agentId: "ag_1",
  startedAt: new Date(START).toISOString(),
  observedRunning: false,
  ...overrides,
});

const runFor = (paseo: RunResult = ok('{"agentId":"ag_1"}')) => {
  const calls: string[][] = [];
  const run: Run = fakeRun((command, args) => {
    calls.push([command, ...args]);
    return command === "paseo" ? paseo : undefined;
  });
  return { run, calls };
};

const contextFor = (run: Run, overrides: Partial<CheckContext> = {}) =>
  testContext({
    run,
    workspaces: [workspace({ labels: [READY_LABEL] })],
    config: testConfig({ provider: "acme/model" }),
    now: () => START,
    ...overrides,
  });

const paseoPrompts = (calls: string[][]) =>
  calls.filter((call) => call[0] === "paseo").map((call) => call.at(-1));

describe("quality check targets", () => {
  it("includes only labelled or in-flight workspaces", async () => {
    const labelled = workspace({ id: "a", labels: [READY_LABEL] });
    const inFlight = workspace({ id: "b", labels: [] });
    const idle = workspace({ id: "c", labels: [] });
    const state = emptyState();
    state.quality.b = entry({ phase: "review" });

    const targets = await createQualityCheck().targets(
      testContext({ workspaces: [labelled, inFlight, idle], state }),
    );

    expect(targets.map((w) => w.id)).toEqual(["a", "b"]);
  });
});

describe("quality check", () => {
  it("skips a workspace with no label and no run", async () => {
    const { run } = runFor();
    const res = await createQualityCheck().run(workspace(), contextFor(run));

    expect(res).toMatchObject({ status: "skip", label: "n/a" });
  });

  it("starts /simplify when the label is set", async () => {
    const { run, calls } = runFor();
    const context = contextFor(run);

    const res = await createQualityCheck().run(
      workspace({ name: "Example", labels: [READY_LABEL] }),
      context,
    );

    expect(res).toMatchObject({ status: "action", label: "simplify" });
    expect(context.state.quality.wks_1).toMatchObject({
      phase: "simplify",
      agentId: "ag_1",
      observedRunning: false,
    });
    expect(paseoPrompts(calls)).toEqual(["/simplify"]);
    const titleCall = calls.find((call) => call.includes("--title"));
    expect(titleCall?.[titleCall.indexOf("--title") + 1]).toBe(
      "Simplify: Example",
    );
  });

  it("reports without acting on a dry run", async () => {
    const { run, calls } = runFor();
    const context = contextFor(run, {
      config: testConfig({ dryRun: true, provider: "acme/model" }),
    });

    const res = await createQualityCheck().run(
      workspace({ labels: [READY_LABEL] }),
      context,
    );

    expect(res).toMatchObject({
      status: "action",
      detail: "would start /simplify",
    });
    expect(context.state.quality).toEqual({});
    expect(paseoPrompts(calls)).toEqual([]);
  });

  it("records nothing when starting the agent fails", async () => {
    const { run } = runFor(fail(1, "boom"));
    const context = contextFor(run);

    const res = await createQualityCheck().run(
      workspace({ labels: [READY_LABEL] }),
      context,
    );

    expect(res).toMatchObject({ status: "error", detail: "boom" });
    expect(context.state.quality).toEqual({});
  });

  it("marks the tracked agent as observed while it runs", async () => {
    const { run } = runFor();
    const state = emptyState();
    const run1 = entry({ phase: "simplify", agentId: "ag_1" });
    state.quality.wks_1 = run1;
    const context = contextFor(run, {
      state,
      runningCwds: new Set(["/repo/worktree"]),
      runningAgentIds: new Set(["ag_1"]),
    });

    const res = await createQualityCheck().run(
      workspace({ labels: [READY_LABEL] }),
      context,
    );

    expect(res).toMatchObject({ status: "skip", label: "simplifying" });
    expect(run1.observedRunning).toBe(true);
  });

  it("ignores an unrelated agent running in the same workspace", async () => {
    const { run, calls } = runFor();
    const state = emptyState();
    const run1 = entry({ phase: "simplify", agentId: "ag_1" });
    state.quality.wks_1 = run1;
    const context = contextFor(run, {
      state,
      runningCwds: new Set(["/repo/worktree"]),
      runningAgentIds: new Set(["other_ag"]),
    });

    const res = await createQualityCheck().run(
      workspace({ labels: [READY_LABEL] }),
      context,
    );

    expect(res).toMatchObject({ status: "skip", label: "simplify" });
    expect(paseoPrompts(calls)).toEqual([]);
    expect(run1.observedRunning).toBe(false);
    expect(state.quality.wks_1?.phase).toBe("simplify");
  });

  it("waits for a start when the agent has not been seen running", async () => {
    const { run, calls } = runFor();
    const state = emptyState();
    state.quality.wks_1 = entry({ observedRunning: false });
    const context = contextFor(run, { state });

    const res = await createQualityCheck().run(
      workspace({ labels: [READY_LABEL] }),
      context,
    );

    expect(res).toMatchObject({ status: "skip", label: "simplify" });
    expect(paseoPrompts(calls)).toEqual([]);
    expect(state.quality.wks_1?.phase).toBe("simplify");
  });

  it("starts a review after simplify was observed running", async () => {
    const { run, calls } = runFor();
    const state = emptyState();
    state.quality.wks_1 = entry({ phase: "simplify", observedRunning: true });
    const context = contextFor(run, { state });

    const res = await createQualityCheck().run(
      workspace({ labels: [READY_LABEL] }),
      context,
    );

    expect(res).toMatchObject({ status: "action", label: "review" });
    expect(state.quality.wks_1).toMatchObject({
      phase: "review",
      observedRunning: false,
    });
    expect(paseoPrompts(calls)).toEqual(["Do a code review of your work."]);
  });

  it("starts a review after the minimum elapsed time without an observation", async () => {
    const { run } = runFor();
    const state = emptyState();
    state.quality.wks_1 = entry({
      phase: "simplify",
      observedRunning: false,
      startedAt: new Date(START - OLD_ENOUGH_MS).toISOString(),
    });
    const context = contextFor(run, { state });

    const res = await createQualityCheck().run(
      workspace({ labels: [READY_LABEL] }),
      context,
    );

    expect(res).toMatchObject({ status: "action", label: "review" });
    expect(state.quality.wks_1?.phase).toBe("review");
  });

  it("clears a run when the label is removed", async () => {
    const { run, calls } = runFor();
    const state = emptyState();
    state.quality.wks_1 = entry({ phase: "simplify" });
    const context = contextFor(run, {
      state,
      workspaces: [workspace({ labels: [] })],
    });

    const res = await createQualityCheck().run(
      workspace({ labels: [] }),
      context,
    );

    expect(res).toMatchObject({ status: "action", label: "cancelled" });
    expect(state.quality.wks_1).toBeUndefined();
    expect(paseoPrompts(calls)).toEqual([]);
  });

  describe("final phase", () => {
    let home: string;
    let statePath: string;

    beforeEach(async () => {
      home = await mkdtemp(join(os.tmpdir(), "paseo-quality-"));
      statePath = join(home, "projects", "workspaces.json");
      await mkdir(join(home, "projects"), { recursive: true });
      await writeFile(
        statePath,
        JSON.stringify([{ workspaceId: "wks_1", labels: [READY_LABEL] }]),
      );
    });

    afterEach(async () => {
      await rm(home, { recursive: true, force: true });
    });

    const reviewContext = (run: Run, overrides: Partial<CheckContext> = {}) => {
      const state = emptyState();
      state.quality.wks_1 = entry({
        phase: "review",
        observedRunning: true,
      });
      return contextFor(run, {
        state,
        config: testConfig({
          provider: "acme/model",
          paseoHome: home,
        }),
        ...overrides,
      });
    };

    it("removes the label and clears the entry", async () => {
      const { run } = runFor();
      const context = reviewContext(run);
      const target = context.workspaces[0];
      if (!target) throw new Error("expected a target workspace");

      const res = await createQualityCheck().run(target, context);

      expect(res).toMatchObject({ status: "action", label: "done" });
      expect(context.state.quality.wks_1).toBeUndefined();
      expect(target.labels).toEqual([]);
      expect(await createQualityCheck().targets(context)).toEqual([]);
      const saved = JSON.parse(await readFile(statePath, "utf8"));
      expect(saved[0].labels).toEqual([]);
    });

    it("reports an error when the label cannot be removed", async () => {
      const { run } = runFor();
      const context = reviewContext(run, {
        config: testConfig({
          provider: "acme/model",
          paseoHome: join(home, "missing"),
        }),
      });

      const res = await createQualityCheck().run(
        workspace({ labels: [READY_LABEL] }),
        context,
      );

      expect(res).toMatchObject({ status: "error", label: "error" });
      expect(context.state.quality.wks_1?.phase).toBe("review");
    });

    it("reports without removing the label on a dry run", async () => {
      const { run } = runFor();
      const context = reviewContext(run, {
        config: testConfig({
          dryRun: true,
          provider: "acme/model",
          paseoHome: home,
        }),
      });

      const res = await createQualityCheck().run(
        workspace({ labels: [READY_LABEL] }),
        context,
      );

      expect(res).toMatchObject({
        status: "action",
        detail: "would remove the label",
      });
      const saved = JSON.parse(await readFile(statePath, "utf8"));
      expect(saved[0].labels).toEqual([READY_LABEL]);
    });
  });
});
