import { afterEach, describe, expect, it, vi } from "vitest";
import { PROJECT_IDENTIFIER, prFooter } from "../plane.ts";
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
import { createPlanePrLinkCheck } from "./link-pr.ts";

const PR_URL = "https://github.com/example/repo/pull/1";

type Options = {
  branch?: string;
  sha?: string | null;
  pr?: RunResult;
};

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
      return (
        opts.pr ?? ok(JSON.stringify({ number: 1, url: PR_URL, body: "" }))
      );
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Plane/PR link check", () => {
  it("lists every workspace as a target", async () => {
    const check = createPlanePrLinkCheck();
    const context = testContext({ workspaces: [workspace()] });
    expect(await check.targets(context)).toEqual([workspace()]);
  });

  it("skips main and detached HEADs", async () => {
    const check = createPlanePrLinkCheck();
    const main = await check.run(
      workspace({ name: `${PROJECT_IDENTIFIER}-1` }),
      contextFor(runFor({ branch: "main" }).run),
    );
    expect(main).toMatchObject({ status: "skip", label: "n/a" });

    const detached = await check.run(
      workspace({ name: `${PROJECT_IDENTIFIER}-1` }),
      contextFor(runFor({ sha: null }).run),
    );
    expect(detached).toMatchObject({ status: "skip", label: "n/a" });
  });

  it("skips a workspace with a running agent", async () => {
    const { run } = runFor();
    const context = contextFor(run, {
      runningCwds: new Set(["/repo/worktree"]),
    });
    const res = await createPlanePrLinkCheck().run(
      workspace({ name: `${PROJECT_IDENTIFIER}-1` }),
      context,
    );
    expect(res).toMatchObject({ status: "skip", label: "busy" });
  });

  it("skips a workspace with no work item ref", async () => {
    const { run } = runFor();
    const res = await createPlanePrLinkCheck().run(
      workspace({ name: "main" }),
      contextFor(run),
    );
    expect(res).toMatchObject({
      status: "skip",
      detail: "no work item in workspace name",
    });
  });

  it("skips a workspace with no pull request", async () => {
    const { run } = runFor({
      pr: fail(1, 'no pull requests found for branch "feature"'),
    });
    const res = await createPlanePrLinkCheck().run(
      workspace(),
      contextFor(run),
    );
    expect(res).toMatchObject({ status: "skip", label: "no pr" });
  });

  it("surfaces a gh failure", async () => {
    const { run } = runFor({ pr: fail(1, "no auth") });
    const res = await createPlanePrLinkCheck().run(
      workspace(),
      contextFor(run),
    );
    expect(res).toMatchObject({ status: "error", detail: "no auth" });
  });

  it("asks for review when the PR lacks the footer", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { run } = runFor({
      pr: ok(JSON.stringify({ number: 1, url: PR_URL, body: "no footer" })),
    });
    const res = await createPlanePrLinkCheck().run(
      workspace(),
      contextFor(run),
    );

    expect(res).toMatchObject({
      status: "action",
      label: "needs link",
      eventKey: "needs-review:abc123",
      eventKind: "needs-review",
    });
    expect(res.detail).toContain(`${PROJECT_IDENTIFIER}-1`);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports what it would do on a dry run", async () => {
    const { run } = runFor({
      pr: ok(JSON.stringify({ number: 1, url: PR_URL, body: "no footer" })),
    });
    const res = await createPlanePrLinkCheck().run(
      workspace(),
      contextFor(run, {
        config: testConfig({ planeApiKey: "key", dryRun: true }),
      }),
    );
    expect(res).toMatchObject({
      status: "action",
      label: "needs link",
      eventKey: "needs-review:abc123",
      eventKind: "needs-review",
    });
    expect(res.detail).toContain("would send /needs-review");
  });

  it("skips the Plane check without a key", async () => {
    const { run } = runFor({
      pr: ok(
        JSON.stringify({
          number: 1,
          url: PR_URL,
          body: prFooter(`${PROJECT_IDENTIFIER}-1`),
        }),
      ),
    });
    const res = await createPlanePrLinkCheck().run(
      workspace(),
      contextFor(run, { config: testConfig({ planeApiKey: "" }) }),
    );
    expect(res).toMatchObject({ status: "skip", label: "no key" });
  });

  it("is ok when the PR and work item are linked and in review", async () => {
    stubPlane({ links: [PR_URL] });
    const { run } = runFor({
      pr: ok(
        JSON.stringify({
          number: 1,
          url: PR_URL,
          body: `Notes\n\n${prFooter(`${PROJECT_IDENTIFIER}-1`)}\n`,
        }),
      ),
    });
    const res = await createPlanePrLinkCheck().run(
      workspace(),
      contextFor(run),
    );
    expect(res).toMatchObject({ status: "ok", label: "linked" });
  });

  it("asks for review when the work item is not in review", async () => {
    stubPlane({ stateName: "In Progress", links: [PR_URL] });
    const { run } = runFor({
      pr: ok(
        JSON.stringify({
          number: 1,
          url: PR_URL,
          body: prFooter(`${PROJECT_IDENTIFIER}-1`),
        }),
      ),
    });
    const res = await createPlanePrLinkCheck().run(
      workspace(),
      contextFor(run),
    );

    expect(res).toMatchObject({
      status: "action",
      eventKey: "needs-review:abc123",
      eventKind: "needs-review",
    });
    expect(res.detail).toContain('not "Needs Review"');
  });

  it("asks for review when the work item lacks the PR link", async () => {
    stubPlane({ stateName: "Needs Review", links: [] });
    const { run } = runFor({
      pr: ok(
        JSON.stringify({
          number: 1,
          url: PR_URL,
          body: prFooter(`${PROJECT_IDENTIFIER}-1`),
        }),
      ),
    });
    const res = await createPlanePrLinkCheck().run(
      workspace(),
      contextFor(run),
    );
    expect(res).toMatchObject({
      status: "action",
      eventKind: "needs-review",
    });
    expect(res.detail).toContain("PR link");
  });

  it("surfaces a Plane API failure", async () => {
    stubPlane({ fail: true });
    const { run } = runFor({
      pr: ok(
        JSON.stringify({
          number: 1,
          url: PR_URL,
          body: prFooter(`${PROJECT_IDENTIFIER}-1`),
        }),
      ),
    });
    const res = await createPlanePrLinkCheck().run(
      workspace(),
      contextFor(run),
    );
    expect(res).toMatchObject({ status: "error", label: "error" });
  });
});
