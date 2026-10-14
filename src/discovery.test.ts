import { describe, expect, it } from "vitest";
import { DEFAULT_REPO } from "./config.ts";
import { discover, discoverRunningAgents } from "./discovery.ts";
import { fail, fakeRun, ok, testConfig } from "./test-helpers.ts";

const REPO = DEFAULT_REPO;

const paseoRun = (workspaces: unknown[], agents: unknown[]) =>
  fakeRun((command, args) => {
    if (command !== "paseo") return undefined;
    const joined = args.join(" ");
    if (joined === "workspace ls --json") return ok(JSON.stringify(workspaces));
    if (joined === "ls --json") return ok(JSON.stringify(agents));
    return undefined;
  });

const workspaceJson = (id: string, cwd = `/${id}`) => ({
  workspaceId: id,
  project: REPO,
  name: id.toUpperCase(),
  cwd,
  isolation: "worktree",
});

describe("discover", () => {
  it("filters workspaces", async () => {
    const run = paseoRun(
      [workspaceJson("keep", "~/a"), workspaceJson("drop", "/drop")],
      [],
    );

    const state = JSON.stringify([
      { workspaceId: "drop", labels: ["skip-updates"] },
      { workspaceId: "other", archivedAt: "2020-01-01" },
    ]);

    const result = await discover(
      testConfig(),
      run,
      "/home/u",
      async () => state,
    );

    expect(result.workspaces).toEqual([
      { id: "keep", name: "KEEP", cwd: "/home/u/a", labels: [] },
    ]);
  });

  it("keeps everything when no workspace state file exists", async () => {
    const run = paseoRun([workspaceJson("a")], []);
    const result = await discover(
      testConfig(),
      run,
      "/home/u",
      async () => null,
    );
    expect(result.workspaces.map((w) => w.id)).toEqual(["a"]);
  });

  it("collapses local workspaces sharing the main checkout", async () => {
    const run = paseoRun(
      [
        {
          workspaceId: "main",
          project: REPO,
          name: "main",
          cwd: "~/repo",
          isolation: "local",
        },
        {
          workspaceId: "wks_watch",
          project: REPO,
          name: "Paseo watch",
          cwd: "~/repo",
          isolation: "local",
        },
        {
          workspaceId: "wks_plane",
          project: REPO,
          name: "Plane",
          cwd: "~/repo",
          isolation: "local",
        },
        {
          workspaceId: "wks_branch",
          project: REPO,
          name: "TASK-1: Work",
          cwd: "~/worktrees/1",
          isolation: "worktree",
        },
      ],
      [],
    );

    const result = await discover(
      testConfig(),
      run,
      "/home/u",
      async () => null,
    );

    expect(result.workspaces.map((w) => w.id)).toEqual(["main", "wks_branch"]);
  });

  it("falls back to the default reader and tolerates a missing file", async () => {
    const run = paseoRun([workspaceJson("a")], []);
    const result = await discover(testConfig(), run);
    expect(result.workspaces.map((w) => w.id)).toEqual(["a"]);
  });

  it("falls back to no filtering when the state file is corrupt", async () => {
    const run = paseoRun([workspaceJson("a")], []);
    const result = await discover(
      testConfig(),
      run,
      "/home/u",
      async () => "not json",
    );
    expect(result.workspaces.map((w) => w.id)).toEqual(["a"]);
  });

  it("throws when the workspace listing fails", async () => {
    const run = fakeRun((command, args) => {
      if (command !== "paseo") return undefined;
      if (args.join(" ") === "workspace ls --json") return fail(1, "boom");
      return ok("[]");
    });
    await expect(discover(testConfig(), run)).rejects.toThrow(
      /Could not list Paseo workspaces/,
    );
  });
});

describe("discoverRunningAgents", () => {
  it("returns only the running agents' cwds and ids", async () => {
    const run = paseoRun(
      [],
      [
        { id: "a", cwd: "~/busy", status: "running" },
        { id: "b", cwd: "/idle", status: "idle" },
      ],
    );

    const running = await discoverRunningAgents(testConfig(), run, "/home/u");

    expect([...running.cwds]).toEqual(["/home/u/busy"]);
    expect([...running.ids]).toEqual(["a"]);
  });

  it("throws when the agent listing fails", async () => {
    const run = fakeRun((command) =>
      command === "paseo" ? fail(1, "nope") : undefined,
    );

    await expect(discoverRunningAgents(testConfig(), run)).rejects.toThrow(
      /Could not list Paseo agents/,
    );
  });
});
