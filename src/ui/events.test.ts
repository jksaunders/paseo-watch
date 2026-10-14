import { note } from "@clack/prompts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyState } from "../state.ts";
import type { CheckResult, Logger } from "../types.ts";
import { presentEvents } from "./events.ts";

vi.mock("@clack/prompts", () => ({
  note: vi.fn(),
}));

const event: CheckResult = {
  target: "TASK-1",
  workspaceId: "wks_1",
  status: "action",
  detail: "ci failed",
  eventKey: "ci:b:r1",
};

const createLogger = (): Logger => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
});

beforeEach(() => {
  vi.mocked(note).mockReset();
});

describe("presentEvents", () => {
  it("reports but does not consume events on a dry run", async () => {
    const state = emptyState();
    await presentEvents({
      results: [event],
      state,
      dryRun: true,
      now: () => new Date(),
      startAgent: vi.fn(),
      logger: createLogger(),
    });
    expect(note).toHaveBeenCalledOnce();
    expect(state.eventsPrompted).toEqual({});
  });

  it("does not consume an event with no workspace to act in", async () => {
    const state = emptyState();
    const startAgent = vi.fn();
    await presentEvents({
      results: [{ ...event, workspaceId: undefined }],
      state,
      dryRun: false,
      now: () => new Date(),
      startAgent,
      logger: createLogger(),
    });
    expect(note).toHaveBeenCalledOnce();
    expect(startAgent).not.toHaveBeenCalled();
    expect(state.eventsPrompted).toEqual({});
  });

  it("marks an event prompted once acted on", async () => {
    const state = emptyState();
    await presentEvents({
      results: [event],
      state,
      dryRun: false,
      now: () => new Date("2020-01-01T00:00:00.000Z"),
      startAgent: vi.fn(async () => ({ ok: true, detail: "started" })),
      logger: createLogger(),
    });
    expect(state.eventsPrompted).toEqual({
      "ci:b:r1": "2020-01-01T00:00:00.000Z",
    });
  });

  it("leaves an event unprompted when the start fails", async () => {
    const state = emptyState();
    const logger = createLogger();
    await presentEvents({
      results: [{ ...event, eventKind: "needs-review" }],
      state,
      dryRun: false,
      now: () => new Date(),
      startAgent: vi.fn(async () => ({ ok: false, detail: "no provider" })),
      logger,
    });
    expect(state.eventsPrompted).toEqual({});
    expect(logger.warn).toHaveBeenCalledWith(
      "Could not start an agent: no provider",
    );
  });

  it.each([
    "circleci",
    "status",
    "needs-review",
    "merge-when-ready",
    "merge-main",
  ] as const)("starts a %s agent directly", async (eventKind) => {
    const startAgent = vi.fn(async () => ({ ok: true, detail: "started" }));
    const logger = createLogger();
    await presentEvents({
      results: [{ ...event, eventKind }],
      state: emptyState(),
      dryRun: false,
      now: () => new Date(),
      startAgent,
      logger,
    });
    expect(startAgent).toHaveBeenCalledWith(
      expect.objectContaining({ eventKind }),
    );
    expect(logger.info).toHaveBeenCalledWith("started");
  });
});
