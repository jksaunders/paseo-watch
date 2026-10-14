import { describe, expect, it } from "vitest";
import {
  dedupeByCwd,
  expandHome,
  findAgentSettings,
  parseRemote,
  parseRunningAgents,
  parseWorkspaceList,
  parseWorkspaceState,
  selectWorkspaces,
} from "./workspaces.ts";

const REPO = "octo/repo";

describe("expandHome", () => {
  it("expands a leading tilde", () => {
    expect(expandHome("~/x", "/home/u")).toBe("/home/u/x");
  });

  it("leaves absolute paths alone", () => {
    expect(expandHome("/x", "/home/u")).toBe("/x");
  });
});

describe("parseRemote", () => {
  it.each([
    ["git@github.com:octo/repo.git", "octo/repo"],
    ["https://github.com/octo/repo.git", "octo/repo"],
    ["https://github.com/octo/repo", "octo/repo"],
  ])("parses %s", (url, expected) => {
    expect(parseRemote(url)).toBe(expected);
  });
});

describe("parseWorkspaceList", () => {
  it("keeps only this repo and expands homes", () => {
    const json = JSON.stringify([
      {
        workspaceId: "a",
        project: REPO,
        name: "A",
        cwd: "~/worktrees/a",
        isolation: "worktree",
      },
      { workspaceId: "b", project: "other/repo", name: "B", cwd: "/b" },
    ]);

    expect(parseWorkspaceList(json, REPO, "/home/u")).toEqual([
      { id: "a", name: "A", cwd: "/home/u/worktrees/a", labels: [] },
    ]);
  });
});

describe("parseRunningAgents", () => {
  it("keeps only running agents' cwds and ids", () => {
    const json = JSON.stringify([
      { id: "a", cwd: "~/a", status: "running" },
      { id: "b", cwd: "/b", status: "idle" },
    ]);
    const running = parseRunningAgents(json, "/home/u");
    expect([...running.cwds]).toEqual(["/home/u/a"]);
    expect([...running.ids]).toEqual(["a"]);
  });
});

describe("findAgentSettings", () => {
  it("returns the provider and thinking of an agent in the matching cwd", () => {
    const json = JSON.stringify([
      { id: "a", cwd: "~/other", status: "idle", provider: "x/y" },
      {
        id: "b",
        cwd: "~/w",
        status: "idle",
        provider: "acme/model",
        thinking: "low",
      },
    ]);
    expect(findAgentSettings(json, "/home/u/w", "/home/u")).toEqual({
      provider: "acme/model",
      thinking: "low",
    });
  });

  it("defaults thinking to empty when the agent has none", () => {
    const json = JSON.stringify([
      { id: "a", cwd: "~/w", status: "idle", provider: "acme/model" },
    ]);
    expect(findAgentSettings(json, "/home/u/w", "/home/u")).toEqual({
      provider: "acme/model",
      thinking: "",
    });
  });

  it("returns null when no agent with a provider matches", () => {
    const json = JSON.stringify([
      { id: "a", cwd: "~/w", status: "idle" },
      { id: "b", cwd: "/elsewhere", status: "idle", provider: "acme/model" },
    ]);
    expect(findAgentSettings(json, "/home/u/w", "/home/u")).toBeNull();
  });
});

describe("parseWorkspaceState", () => {
  it("maps labels and archived status", () => {
    const json = JSON.stringify([
      { workspaceId: "a", labels: ["skip-updates"], archivedAt: null },
      { workspaceId: "b", archivedAt: "2020-01-01" },
    ]);
    const states = parseWorkspaceState(json);
    expect(states.get("a")).toEqual({
      labels: ["skip-updates"],
      archived: false,
    });
    expect(states.get("b")).toEqual({ labels: [], archived: true });
  });
});

describe("dedupeByCwd", () => {
  it("keeps one workspace per cwd, preferring the main one", () => {
    const workspaces = [
      { id: "main", name: "main", cwd: "/repo", labels: [] },
      { id: "wks_a", name: "Paseo watch", cwd: "/repo", labels: [] },
      { id: "wks_b", name: "Plane", cwd: "/repo", labels: [] },
      { id: "wks_c", name: "TASK-1: Work", cwd: "/worktrees/1", labels: [] },
    ];

    expect(dedupeByCwd(workspaces).map((w) => w.id)).toEqual(["main", "wks_c"]);
  });

  it("keeps the first workspace when none is named main", () => {
    const workspaces = [
      { id: "a", name: "Alpha", cwd: "/repo", labels: [] },
      { id: "b", name: "Beta", cwd: "/repo", labels: [] },
    ];

    expect(dedupeByCwd(workspaces).map((w) => w.id)).toEqual(["a"]);
  });

  it("leaves workspaces with unique cwds alone", () => {
    const workspaces = [
      { id: "a", name: "A", cwd: "/a", labels: [] },
      { id: "b", name: "B", cwd: "/b", labels: [] },
    ];

    expect(dedupeByCwd(workspaces).map((w) => w.id)).toEqual(["a", "b"]);
  });
});

describe("selectWorkspaces", () => {
  const workspaces = [
    { id: "keep", name: "Keep", cwd: "/keep", labels: [] },
    { id: "skipped", name: "Skipped", cwd: "/skipped", labels: [] },
    { id: "archived", name: "Archived", cwd: "/archived", labels: [] },
    { id: "unknown", name: "Unknown", cwd: "/unknown", labels: [] },
  ];

  it("drops archived and labelled workspaces, keeps unknown ones", () => {
    const states = parseWorkspaceState(
      JSON.stringify([
        { workspaceId: "skipped", labels: ["skip-updates"] },
        { workspaceId: "archived", archivedAt: "2020-01-01" },
      ]),
    );

    expect(
      selectWorkspaces(workspaces, states, ["skip-updates"]).map((w) => w.id),
    ).toEqual(["keep", "unknown"]);
  });

  it("carries the workspace's labels onto the selected workspace", () => {
    const states = parseWorkspaceState(
      JSON.stringify([
        { workspaceId: "keep", labels: ["ready-for-quality"] },
        { workspaceId: "skipped", labels: ["skip-updates"] },
      ]),
    );

    const selected = selectWorkspaces(workspaces, states, ["skip-updates"]);

    expect(selected.find((w) => w.id === "keep")?.labels).toEqual([
      "ready-for-quality",
    ]);
    expect(selected.find((w) => w.id === "unknown")?.labels).toEqual([]);
  });
});
