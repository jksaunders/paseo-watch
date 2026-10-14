import { describe, expect, it } from "vitest";
import { startWorkspaceAgent } from "./agent.ts";
import { fail, fakeRun, ok } from "./test-helpers.ts";

const options = {
  paseoCli: "paseo",
  provider: "openai/gpt-5",
  workspaceId: "wks_1",
  title: "Resolve CI: TASK-1",
  prompt: "do the thing",
};

describe("startWorkspaceAgent", () => {
  it("runs a background agent with the failure report", async () => {
    const calls: string[][] = [];
    const run = fakeRun((command, args) => {
      calls.push([command, ...args]);
      return ok('{"agentId":"a1"}');
    });

    const outcome = await startWorkspaceAgent(run, options);

    expect(outcome.ok).toBe(true);
    expect(outcome.agentId).toBe("a1");
    expect(calls[0]).toEqual([
      "paseo",
      "run",
      "--workspace",
      "wks_1",
      "--provider",
      "openai/gpt-5",
      "--thinking",
      "high",
      "--title",
      "Resolve CI: TASK-1",
      "--background",
      "--json",
      "do the thing",
    ]);
  });

  it("refuses when no provider is configured or discoverable", async () => {
    const outcome = await startWorkspaceAgent(
      fakeRun(() => ok()),
      {
        ...options,
        provider: "",
        workspaceCwd: "/home/me/w",
        home: "/home/me",
      },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/provider/i);
  });

  it("resolves the provider and thinking from an agent in the workspace", async () => {
    const calls: string[][] = [];
    const run = fakeRun((command, args) => {
      calls.push([command, ...args]);
      if (command === "paseo" && args.join(" ") === "ls --json") {
        return ok(
          JSON.stringify([
            { id: "a", cwd: "~/other", status: "idle", provider: "x/y" },
            {
              id: "b",
              cwd: "~/w",
              status: "idle",
              provider: "acme/model",
              thinking: "low",
            },
          ]),
        );
      }
      return ok('{"agentId":"a1"}');
    });

    const outcome = await startWorkspaceAgent(run, {
      ...options,
      provider: "",
      workspaceCwd: "/home/me/w",
      home: "/home/me",
    });

    expect(outcome.ok).toBe(true);
    const runCall = calls.find((call) => call.includes("run"));
    expect(runCall?.[(runCall?.indexOf("--provider") ?? -1) + 1]).toBe(
      "acme/model",
    );
    expect(runCall?.[(runCall?.indexOf("--thinking") ?? -1) + 1]).toBe("low");
  });

  it("defaults to high thinking when the resolved agent has none", async () => {
    const calls: string[][] = [];
    const run = fakeRun((command, args) => {
      calls.push([command, ...args]);
      if (command === "paseo" && args.join(" ") === "ls --json") {
        return ok(
          JSON.stringify([
            { id: "b", cwd: "~/w", status: "idle", provider: "acme/model" },
          ]),
        );
      }
      return ok('{"agentId":"a1"}');
    });

    await startWorkspaceAgent(run, {
      ...options,
      provider: "",
      workspaceCwd: "/home/me/w",
      home: "/home/me",
    });

    const runCall = calls.find((call) => call.includes("run"));
    expect(runCall?.[(runCall?.indexOf("--thinking") ?? -1) + 1]).toBe("high");
  });

  it("refuses when there is no workspace", async () => {
    const outcome = await startWorkspaceAgent(
      fakeRun(() => ok()),
      {
        ...options,
        workspaceId: "",
      },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/No workspace/);
  });

  it("falls back to a nested agent id", async () => {
    const outcome = await startWorkspaceAgent(
      fakeRun(() => ok('{"agent":{"id":"a2"}}')),
      options,
    );
    expect(outcome.agentId).toBe("a2");
  });

  it("returns an empty id when the output is not parseable", async () => {
    const outcome = await startWorkspaceAgent(
      fakeRun(() => ok("started")),
      options,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.agentId).toBe("");
  });

  it("reports a failed invocation", async () => {
    const outcome = await startWorkspaceAgent(
      fakeRun(() => fail(1, "no such workspace")),
      options,
    );
    expect(outcome).toEqual({ ok: false, detail: "no such workspace" });
  });
});
