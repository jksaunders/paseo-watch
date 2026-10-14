import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emptyState,
  isCommitPassed,
  isPrompted,
  loadState,
  markPrompted,
  parseState,
  pruneState,
  recordCommit,
  saveState,
  serializeState,
  unpromptedEvents,
} from "./state.ts";

describe("parseState", () => {
  it("returns empty for null", () => {
    expect(parseState(null)).toEqual(emptyState());
  });

  it("returns empty for corrupt json", () => {
    expect(parseState("{not json")).toEqual(emptyState());
  });

  it("defaults a missing commits map", () => {
    const parsed = parseState(JSON.stringify({ eventsPrompted: { k: "at" } }));
    expect(parsed).toEqual({
      eventsPrompted: { k: "at" },
      commits: {},
      quality: {},
      installs: {},
    });
  });

  it("defaults a missing quality map", () => {
    const parsed = parseState(JSON.stringify({}));
    expect(parsed.quality).toEqual({});
  });

  it("defaults a missing installs map", () => {
    const parsed = parseState(JSON.stringify({}));
    expect(parsed.installs).toEqual({});
  });

  it("round-trips a valid state", () => {
    const state = {
      eventsPrompted: { "status:abc": "2020-01-01T00:00:00.000Z" },
      commits: {
        abc: {
          state: "passed" as const,
          checkedAt: "2020-01-01T00:00:00.000Z",
          pull: null,
        },
      },
      quality: {
        wks_1: {
          phase: "simplify" as const,
          agentId: "ag_1",
          startedAt: "2020-01-01T00:00:00.000Z",
          observedRunning: false,
        },
      },
      installs: { "/repo/worktree": "2020-01-01T00:00:00.000Z" },
    };
    expect(parseState(serializeState(state))).toEqual(state);
  });
});

describe("prompted event tracking", () => {
  it("marks and reads a key", () => {
    const state = emptyState();
    expect(isPrompted(state, "k")).toBe(false);
    markPrompted(state, "k", "2020-01-01T00:00:00.000Z");
    expect(isPrompted(state, "k")).toBe(true);
  });

  it("returns only actionable, unprompted events", () => {
    const state = emptyState();
    markPrompted(state, "seen", "2020-01-01T00:00:00.000Z");
    const results = [
      { status: "action", eventKey: "seen" },
      { status: "action", eventKey: "fresh" },
      { status: "ok", eventKey: "quiet" },
      { status: "action" },
    ];
    expect(unpromptedEvents(results, state)).toEqual([
      { status: "action", eventKey: "fresh" },
    ]);
  });
});

describe("commit tracking", () => {
  it("trusts a pass only for the pull request it was recorded against", () => {
    const state = emptyState();
    expect(isCommitPassed(state, "abc", 7)).toBe(false);
    recordCommit(state, "abc", "passed", Date.parse("2020-01-01T00:00:00Z"), 7);
    expect(isCommitPassed(state, "abc", 7)).toBe(true);
    expect(state.commits.abc?.checkedAt).toBe("2020-01-01T00:00:00.000Z");
  });

  it("does not trust a pass recorded before a PR existed", () => {
    const state = emptyState();
    recordCommit(state, "abc", "passed", Date.now(), null);
    expect(isCommitPassed(state, "abc", null)).toBe(false);
    expect(isCommitPassed(state, "abc", 7)).toBe(false);
  });

  it("does not trust a pass recorded against another PR", () => {
    const state = emptyState();
    recordCommit(state, "abc", "passed", Date.now(), 7);
    expect(isCommitPassed(state, "abc", 8)).toBe(false);
  });

  it("does not treat a failed commit as passed", () => {
    const state = emptyState();
    recordCommit(state, "abc", "failed", Date.now(), 7);
    expect(isCommitPassed(state, "abc", 7)).toBe(false);
  });
});

describe("pruneState", () => {
  it("drops prompted events and commits older than the max age", () => {
    const state = {
      eventsPrompted: {
        old: "2020-01-01T00:00:00.000Z",
        recent: "2020-01-02T00:00:00.000Z",
        bad: "not a date",
      },
      commits: {
        stale: {
          state: "passed" as const,
          checkedAt: "2020-01-01T00:00:00.000Z",
          pull: null,
        },
        fresh: {
          state: "passed" as const,
          checkedAt: "2020-01-02T00:00:00.000Z",
          pull: null,
        },
      },
      quality: {
        stale: {
          phase: "simplify" as const,
          agentId: "",
          startedAt: "2020-01-01T00:00:00.000Z",
          observedRunning: false,
        },
        fresh: {
          phase: "review" as const,
          agentId: "",
          startedAt: "2020-01-02T00:00:00.000Z",
          observedRunning: false,
        },
      },
      installs: {
        "/repo/stale": "2020-01-01T00:00:00.000Z",
        "/repo/fresh": "2020-01-02T00:00:00.000Z",
      },
    };

    pruneState(state, Date.parse("2020-01-03T00:00:00.000Z"), 86_400_000);

    expect(Object.keys(state.eventsPrompted)).toEqual(["recent", "bad"]);
    expect(Object.keys(state.commits)).toEqual(["fresh"]);
    expect(Object.keys(state.quality)).toEqual(["fresh"]);
    expect(Object.keys(state.installs)).toEqual(["/repo/fresh"]);
  });
});

describe("loadState / saveState", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(os.tmpdir(), "paseo-watch-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips through disk and creates missing directories", async () => {
    const path = join(dir, "nested", "state.json");
    expect(await loadState(path)).toEqual(emptyState());

    await saveState(path, {
      eventsPrompted: { k: "at" },
      commits: { abc: { state: "passed", checkedAt: "at", pull: null } },
      quality: {},
      installs: { "/repo/worktree": "at" },
    });
    expect(await loadState(path)).toEqual({
      eventsPrompted: { k: "at" },
      commits: { abc: { state: "passed", checkedAt: "at", pull: null } },
      quality: {},
      installs: { "/repo/worktree": "at" },
    });
    expect(await readFile(path, "utf8")).toContain('"abc"');
  });

  it("leaves no temp file behind", async () => {
    const path = join(dir, "state.json");
    await saveState(path, emptyState());

    expect(await readdir(dir)).toEqual(["state.json"]);
  });

  it("falls back to empty when the file is missing", async () => {
    expect(await loadState(join(dir, "missing.json"))).toEqual(emptyState());
  });
});
