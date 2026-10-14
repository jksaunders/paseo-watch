import { describe, expect, it } from "vitest";
import {
  fetchCombinedStatus,
  fetchPullRequest,
  isFailedState,
  isPendingState,
} from "./github.ts";
import { fail, fakeRun, ok } from "./test-helpers.ts";

const combined = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    state: "success",
    sha: "abc123",
    statuses: [
      {
        context: "ci/circleci: build_and_deploy",
        state: "success",
        description: "Passed",
        target_url: "https://circleci.example/1",
      },
    ],
    ...overrides,
  });

describe("status state helpers", () => {
  it.each(["failure", "error"])("treats %s as failed", (state) => {
    expect(isFailedState(state)).toBe(true);
  });

  it.each(["success", "pending"])("does not treat %s as failed", (state) => {
    expect(isFailedState(state)).toBe(false);
  });

  it("detects pending", () => {
    expect(isPendingState("pending")).toBe(true);
    expect(isPendingState("success")).toBe(false);
  });
});

describe("fetchCombinedStatus", () => {
  it("maps the combined status", async () => {
    const outcome = await fetchCombinedStatus(
      fakeRun(() => ok(combined())),
      "octo/repo",
      "abc123",
    );

    expect(outcome).toEqual({
      kind: "status",
      status: {
        state: "success",
        sha: "abc123",
        statuses: [
          {
            context: "ci/circleci: build_and_deploy",
            state: "success",
            description: "Passed",
            targetUrl: "https://circleci.example/1",
          },
        ],
      },
    });
  });

  it("defaults a missing description and url", async () => {
    const outcome = await fetchCombinedStatus(
      fakeRun(() =>
        ok(
          JSON.stringify({
            state: "pending",
            sha: "abc",
            statuses: [{ context: "ci", state: "pending" }],
          }),
        ),
      ),
      "o/r",
      "abc",
    );

    expect(outcome).toEqual({
      kind: "status",
      status: {
        state: "pending",
        sha: "abc",
        statuses: [
          { context: "ci", state: "pending", description: "", targetUrl: "" },
        ],
      },
    });
  });

  it("tolerates null description and url", async () => {
    const outcome = await fetchCombinedStatus(
      fakeRun(() =>
        ok(
          JSON.stringify({
            state: "failure",
            sha: "abc",
            statuses: [
              {
                context: "ci/circleci: build",
                state: "failure",
                description: null,
                target_url: null,
              },
            ],
          }),
        ),
      ),
      "o/r",
      "abc",
    );

    expect(outcome).toEqual({
      kind: "status",
      status: {
        state: "failure",
        sha: "abc",
        statuses: [
          {
            context: "ci/circleci: build",
            state: "failure",
            description: "",
            targetUrl: "",
          },
        ],
      },
    });
  });

  it("reports gh failures", async () => {
    expect(
      await fetchCombinedStatus(
        fakeRun(() => fail(1, "no auth")),
        "o/r",
        "abc",
      ),
    ).toEqual({ kind: "error", detail: "no auth" });
  });

  it("reports unparseable output", async () => {
    expect(
      await fetchCombinedStatus(
        fakeRun(() => ok("nope")),
        "o/r",
        "abc",
      ),
    ).toEqual({ kind: "error", detail: "Could not parse gh output" });
  });
});

describe("fetchPullRequest", () => {
  it("reads the pull request for the branch", async () => {
    const outcome = await fetchPullRequest(
      fakeRun(() =>
        ok(
          JSON.stringify({
            number: 12,
            url: "https://github.com/o/r/pull/12",
            body: "hello",
          }),
        ),
      ),
      "/repo/worktree",
    );

    expect(outcome).toEqual({
      kind: "found",
      pull: {
        number: 12,
        url: "https://github.com/o/r/pull/12",
        body: "hello",
      },
    });
  });

  it("reports a missing pull request", async () => {
    const outcome = await fetchPullRequest(
      fakeRun(() => fail(1, 'no pull requests found for branch "feature"')),
      "/repo/worktree",
    );
    expect(outcome).toEqual({ kind: "none" });
  });

  it("reports other gh failures", async () => {
    const outcome = await fetchPullRequest(
      fakeRun(() => fail(1, "no auth")),
      "/repo/worktree",
    );
    expect(outcome).toEqual({ kind: "error", detail: "no auth" });
  });

  it("reports unparseable output", async () => {
    const outcome = await fetchPullRequest(
      fakeRun(() => ok("nope")),
      "/repo/worktree",
    );
    expect(outcome).toEqual({
      kind: "error",
      detail: "Could not parse gh output",
    });
  });
});
