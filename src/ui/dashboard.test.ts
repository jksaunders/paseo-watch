import { describe, expect, it } from "vitest";
import { testContext, workspace } from "../test-helpers.ts";
import type { Check } from "../types.ts";
import { createDashboard } from "./dashboard.ts";
import type { Screen } from "./screen.ts";

const recordingScreen = (): Screen & { frames: string[][] } => {
  const frames: string[][] = [];
  return {
    isTTY: true,
    columns: 100,
    frames,
    update: (lines) => {
      frames.push(lines);
    },
    clear: () => {},
    reset: () => {},
    final: (lines) => {
      frames.push(lines);
    },
  };
};

const okCheck = (name: string, column: string): Check => ({
  name,
  column,
  targets: async () => [workspace({ id: "w1", name: "TASK-1" })],
  run: async (target) => ({
    target: target.name,
    workspaceId: target.id,
    status: "ok",
    detail: "nothing to push",
    label: "clean",
  }),
});

describe("dashboard", () => {
  it("renders a frame as each check completes and returns results", async () => {
    const screen = recordingScreen();
    const dashboard = createDashboard({
      checks: [
        okCheck("Push unpushed commits", "push"),
        okCheck("CircleCI failures", "ci"),
      ],
      context: testContext({ workspaces: [workspace()] }),
      screen,
      now: () => 0,
    });

    const results = await dashboard.run();

    expect(results.workspaces).toHaveLength(2);
    expect(screen.frames.length).toBeGreaterThan(2);
    const last = screen.frames.at(-1)?.join("\n") ?? "";
    expect(last).toContain("TASK-1");
    expect(last).toContain("push");
    expect(last).toContain("ci");
    expect(last).toContain("clean");
  });

  it("shows the first line of a failure under its row", async () => {
    const screen = recordingScreen();
    const failing: Check = {
      name: "CircleCI failures",
      column: "ci",
      targets: async () => [workspace({ id: "w1", name: "TASK-1" })],
      run: async (target) => ({
        target: target.name,
        workspaceId: target.id,
        status: "action",
        detail: "step 3 failed\nmore detail",
        label: "failed",
      }),
    };

    const dashboard = createDashboard({
      checks: [failing],
      context: testContext({ workspaces: [workspace()] }),
      screen,
      now: () => 0,
    });
    await dashboard.run();

    const last = screen.frames.at(-1)?.join("\n") ?? "";
    expect(last).toContain("step 3 failed");
    expect(last).not.toContain("more detail");
  });

  it("shows a detail line for every notable column", async () => {
    const screen = recordingScreen();
    const failing = (name: string, column: string, detail: string): Check => ({
      name,
      column,
      targets: async () => [workspace({ id: "w1", name: "TASK-1" })],
      run: async (target) => ({
        target: target.name,
        workspaceId: target.id,
        status: "action",
        detail,
        label: "x",
      }),
    });

    const dashboard = createDashboard({
      checks: [
        failing("Push unpushed commits", "push", "pushed 5 commits"),
        failing("Status", "status", "checks failed"),
      ],
      context: testContext({ workspaces: [workspace()] }),
      screen,
      now: () => 0,
    });
    await dashboard.run();

    const last = screen.frames.at(-1)?.join("\n") ?? "";
    expect(last).toContain("pushed 5 commits");
    expect(last).toContain("checks failed");
  });

  it("shows a sticky notice across runs", async () => {
    const screen = recordingScreen();
    let first = true;
    const notifier: Check = {
      name: "Pull main",
      column: "pull",
      targets: async () => [workspace({ id: "w1", name: "main" })],
      run: async (target) => ({
        target: target.name,
        workspaceId: target.id,
        status: "ok",
        detail: "already up to date",
        label: "up to date",
        notice: first ? "restart to pick up new watcher code" : undefined,
      }),
    };

    const dashboard = createDashboard({
      checks: [notifier],
      context: testContext({ workspaces: [workspace()] }),
      screen,
      now: () => 0,
    });

    await dashboard.run();
    first = false;
    await dashboard.run();

    const last = screen.frames.at(-1)?.join("\n") ?? "";
    expect(last).toContain("restart to pick up new watcher code");
  });

  it("leaves a check blank when it does not target a workspace", async () => {
    const screen = recordingScreen();
    const noTargets: Check = {
      name: "Quality",
      column: "quality",
      targets: async () => [],
      run: async (target) => ({
        target: target.name,
        workspaceId: target.id,
        status: "skip",
        detail: "no quality label",
        label: "n/a",
      }),
    };

    const dashboard = createDashboard({
      checks: [okCheck("Push unpushed commits", "push"), noTargets],
      context: testContext({ workspaces: [workspace()] }),
      screen,
      now: () => 0,
    });
    await dashboard.run();

    const last = screen.frames.at(-1)?.join("\n") ?? "";
    expect(last).toContain("push");
    expect(last).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });

  it("renders a global-check section below the workspace table", async () => {
    const screen = recordingScreen();
    const globalCheck = {
      name: "Supply chain",
      run: async () => ({
        status: "error" as const,
        detail: "Cloudflare: DNS issues\nCloudflare: Gateway issues",
        label: "Cloudflare",
      }),
    };

    const dashboard = createDashboard({
      checks: [okCheck("Push unpushed commits", "push")],
      globalChecks: [globalCheck],
      context: testContext({ workspaces: [workspace()] }),
      screen,
      now: () => 0,
    });

    const results = await dashboard.run();

    expect(results.global).toHaveLength(1);
    const lines = screen.frames.at(-1) ?? [];
    const last = lines.join("\n");
    expect(last).toContain("CHECK");
    expect(last).toContain("Supply chain");
    expect(last).toContain("Cloudflare");
    // Each incident gets its own detail line rather than one run-on line.
    expect(lines.some((line) => line.includes("DNS issues"))).toBe(true);
    expect(lines.some((line) => line.includes("Gateway issues"))).toBe(true);
    expect(
      lines.some(
        (line) =>
          line.includes("DNS issues") && line.includes("Gateway issues"),
      ),
    ).toBe(false);
  });

  it("writes a final frame with the footer on finish", () => {
    const screen = recordingScreen();
    const dashboard = createDashboard({
      checks: [],
      context: testContext(),
      screen,
    });

    dashboard.setFooter("done · every check passed");
    dashboard.finish();

    expect(screen.frames.at(-1)?.join("\n")).toContain(
      "done · every check passed",
    );
  });
});
