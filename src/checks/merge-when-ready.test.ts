import { afterEach, describe, expect, it, vi } from "vitest";
import { MERGE_WHEN_READY_LABEL } from "../labels.ts";
import { PROJECT_IDENTIFIER, prFooter } from "../plane.ts";
import { emptyState, markPrompted, unpromptedEvents } from "../state.ts";
import {
  fail,
  fakeRun,
  ok,
  stubPlane,
  testConfig,
  testContext,
  workspace,
} from "../test-helpers.ts";
import type { CheckContext, Run, RunResult } from "../types.ts";
import { createMergeWhenReadyCheck } from "./merge-when-ready.ts";

const PR_URL = "https://github.com/example/repo/pull/1";

type Options = {
  branch?: string;
  sha?: string | null;
  pr?: RunResult;
};

const labeled = () => workspace({ labels: [MERGE_WHEN_READY_LABEL] });

const prJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    number: 1,
    url: PR_URL,
    body: `Notes\n\n${prFooter(`${PROJECT_IDENTIFIER}-1`)}\n`,
    ...overrides,
  });

const runFor = (opts: Options = {}) => {
  const run: Run = fakeRun((command, args) => {
    if (command === "git") {
      const joined = args.join(" ");
      if (joined.includes("--symbolic-full-name")) return ok("origin/feature");
      if (joined.endsWith("--abbrev-ref HEAD"))
        return ok(`${opts.branch ?? "feature"}\n`);
      if (joined.endsWith("rev-parse HEAD")) {
        return opts.sha === null ? fail(1) : ok(`${opts.sha ?? "abc123"}\n`);
      }
      if (joined.includes("status --porcelain")) return ok("");
      if (joined.includes("log -1 --format=%ct")) return ok("1000\n");
      if (joined.includes("rev-list --count")) return ok("0\n");
    }
    if (command === "gh") {
      return opts.pr ?? ok(prJson());
    }
    return undefined;
  });
  return { run };
};

const contextFor = (
  run: Run,
  overrides: Partial<CheckContext> = {},
): CheckContext =>
  testContext({
    run,
    workspaces: [workspace()],
    config: testConfig({ planeApiKey: "key" }),
    ...overrides,
  });

const passedState = () => {
  const state = emptyState();
  state.commits.abc123 = {
    state: "passed",
    checkedAt: "2020-01-01T00:00:00.000Z",
    pull: 1,
  };
  return state;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("merge-when-ready check", () => {
  it("lists every workspace as a target", async () => {
    const check = createMergeWhenReadyCheck();
    const context = testContext({ workspaces: [workspace()] });
    expect(await check.targets(context)).toEqual([workspace()]);
  });

  it("skips main, detached HEADs and busy workspaces", async () => {
    const check = createMergeWhenReadyCheck();
    const main = await check.run(
      labeled(),
      contextFor(runFor({ branch: "main" }).run),
    );
    expect(main).toMatchObject({ status: "skip", label: "n/a" });

    const detached = await check.run(
      labeled(),
      contextFor(runFor({ sha: null }).run),
    );
    expect(detached).toMatchObject({ status: "skip", label: "n/a" });

    const busy = await check.run(
      labeled(),
      contextFor(runFor().run, {
        runningCwds: new Set(["/repo/worktree"]),
      }),
    );
    expect(busy).toMatchObject({ status: "skip", label: "busy" });
  });

  it("skips a workspace with no work item ref", async () => {
    const res = await createMergeWhenReadyCheck().run(
      workspace({ name: "main", labels: [MERGE_WHEN_READY_LABEL] }),
      contextFor(runFor().run),
    );
    expect(res).toMatchObject({
      status: "skip",
      detail: "no work item in workspace name",
    });
  });

  it("skips when there is no pull request", async () => {
    const res = await createMergeWhenReadyCheck().run(
      labeled(),
      contextFor(
        runFor({ pr: fail(1, 'no pull requests found for branch "feature"') })
          .run,
      ),
    );
    expect(res).toMatchObject({ status: "skip", label: "no pr" });
  });

  it("surfaces a gh failure", async () => {
    const res = await createMergeWhenReadyCheck().run(
      labeled(),
      contextFor(runFor({ pr: fail(1, "no auth") }).run),
    );
    expect(res).toMatchObject({ status: "error", detail: "no auth" });
  });

  it("does not fire without the merge-when-ready label", async () => {
    const res = await createMergeWhenReadyCheck().run(
      workspace(),
      contextFor(runFor().run, { state: passedState() }),
    );
    expect(res).toMatchObject({ status: "skip", label: "no label" });
    expect(res.eventKey).toBeUndefined();
  });

  it("does not fire while checks are still pending", async () => {
    const state = emptyState();
    const res = await createMergeWhenReadyCheck().run(
      labeled(),
      contextFor(runFor().run, { state }),
    );
    expect(res).toMatchObject({ status: "skip", label: "checks" });
    expect(res.eventKey).toBeUndefined();
  });

  it("does not fire when the work item is not in review", async () => {
    stubPlane({ stateName: "In Progress", links: [PR_URL] });
    const res = await createMergeWhenReadyCheck().run(
      labeled(),
      contextFor(runFor().run, { state: passedState() }),
    );
    expect(res).toMatchObject({ status: "skip", label: "not in review" });
    expect(res.eventKey).toBeUndefined();
  });

  it("does not fire when the PR is missing the work item footer", async () => {
    stubPlane({ stateName: "Needs Review", links: [PR_URL] });
    const res = await createMergeWhenReadyCheck().run(
      labeled(),
      contextFor(runFor({ pr: ok(prJson({ body: "no footer" })) }).run, {
        state: passedState(),
      }),
    );
    expect(res).toMatchObject({ status: "skip", label: "not in review" });
    expect(res.eventKey).toBeUndefined();
  });

  it("skips the review check without a Plane key", async () => {
    const res = await createMergeWhenReadyCheck().run(
      labeled(),
      contextFor(runFor().run, {
        state: passedState(),
        config: testConfig({ planeApiKey: "" }),
      }),
    );
    expect(res).toMatchObject({ status: "skip", label: "no key" });
  });

  it("fires once when the PR is green and in review", async () => {
    stubPlane({ stateName: "Needs Review", links: [PR_URL] });
    const state = passedState();
    const res = await createMergeWhenReadyCheck().run(
      labeled(),
      contextFor(runFor().run, { state }),
    );

    expect(res).toMatchObject({
      status: "action",
      label: "done",
      eventKey: "merge-when-ready:abc123",
      eventKind: "merge-when-ready",
    });

    const unprompted = unpromptedEvents([res], state);
    expect(unprompted).toHaveLength(1);
    markPrompted(state, res.eventKey ?? "", "2020-01-01T00:00:00.000Z");
    expect(unpromptedEvents([res], state)).toHaveLength(0);
  });

  it("reports what it would do on a dry run", async () => {
    stubPlane({ stateName: "Needs Review", links: [PR_URL] });
    const res = await createMergeWhenReadyCheck().run(
      labeled(),
      contextFor(runFor().run, {
        state: passedState(),
        config: testConfig({ planeApiKey: "key", dryRun: true }),
      }),
    );
    expect(res).toMatchObject({
      status: "action",
      label: "done",
      eventKey: "merge-when-ready:abc123",
      eventKind: "merge-when-ready",
    });
    expect(res.detail).toBe("would send /done");
  });
});
