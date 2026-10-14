import { describe, expect, it } from "vitest";
import {
  installDependencies,
  installNow,
  runQueuedInstall,
} from "./install.ts";
import { emptyState } from "./state.ts";
import { fail, fakeRun, ok, testConfig, testContext } from "./test-helpers.ts";

const QUEUED_AT = "2020-01-01T00:00:00.000Z";
const CWD = "/repo/worktree";

describe("installDependencies", () => {
  it("runs a frozen-lockfile install in the cwd", async () => {
    const calls: string[][] = [];
    const run = fakeRun((command, args) => {
      calls.push([command, ...args]);
      return command === "pnpm" ? ok() : undefined;
    });

    expect(await installDependencies(run, CWD)).toEqual({ ok: true });
    expect(calls).toEqual([["pnpm", "install", "--frozen-lockfile"]]);
  });

  it("surfaces stderr when the install fails", async () => {
    const run = fakeRun(() => fail(1, "ENOENT pnpm"));
    expect(await installDependencies(run, CWD)).toEqual({
      ok: false,
      detail: "ENOENT pnpm",
    });
  });
});

describe("installNow", () => {
  it("clears the cwd once the install succeeds", async () => {
    const run = fakeRun(() => ok());
    const state = emptyState();

    expect(await installNow(testContext({ run, state }), CWD)).toEqual({
      ok: true,
    });
    expect(state.installs[CWD]).toBeUndefined();
  });

  it("keeps the cwd queued when the install fails", async () => {
    const run = fakeRun(() => fail(1, "boom"));
    const state = emptyState();

    expect(await installNow(testContext({ run, state }), CWD)).toEqual({
      ok: false,
      detail: "boom",
    });
    expect(state.installs[CWD]).toBeDefined();
  });

  it("keeps the original queued time when retrying", async () => {
    const run = fakeRun(() => fail(1, "boom"));
    const state = emptyState();
    state.installs[CWD] = QUEUED_AT;

    await installNow(testContext({ run, state }), CWD);

    expect(state.installs[CWD]).toBe(QUEUED_AT);
  });
});

describe("runQueuedInstall", () => {
  it("does nothing when no install is queued", async () => {
    const run = fakeRun(() => undefined);
    expect(await runQueuedInstall(testContext({ run }), CWD)).toBeNull();
  });

  it("clears the queue on success", async () => {
    const run = fakeRun(() => ok());
    const state = emptyState();
    state.installs[CWD] = QUEUED_AT;

    expect(await runQueuedInstall(testContext({ run, state }), CWD)).toEqual({
      status: "action",
      detail: "installed dependencies",
      label: "installed",
    });
    expect(state.installs[CWD]).toBeUndefined();
  });

  it("keeps the queue on failure", async () => {
    const run = fakeRun(() => fail(1, "boom"));
    const state = emptyState();
    state.installs[CWD] = QUEUED_AT;

    expect(await runQueuedInstall(testContext({ run, state }), CWD)).toEqual({
      status: "error",
      detail: "boom",
      label: "install failed",
    });
    expect(state.installs[CWD]).toBeDefined();
  });

  it("does not install in a dry run", async () => {
    const run = fakeRun(() => undefined);
    const state = emptyState();
    state.installs[CWD] = QUEUED_AT;
    const context = testContext({
      run,
      state,
      config: testConfig({ dryRun: true }),
    });

    expect(await runQueuedInstall(context, CWD)).toMatchObject({
      status: "action",
      label: "to install",
    });
    expect(state.installs[CWD]).toBeDefined();
  });
});
