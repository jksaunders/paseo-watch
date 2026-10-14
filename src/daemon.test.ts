import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { acquireLock, releaseLock, runDaemon } from "./daemon.ts";
import { silentLogger } from "./run.ts";
import { testContext } from "./test-helpers.ts";
import type { TickResults } from "./types.ts";
import type { Dashboard } from "./ui/dashboard.ts";

describe("single-instance lock", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(os.tmpdir(), "paseo-watch-lock-"));
    path = join(dir, "nested", "watch.lock");
    await mkdir(join(dir, "nested"), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates and removes the lock", async () => {
    await acquireLock(path);
    await releaseLock(path);
    await expect(acquireLock(path)).resolves.toBeUndefined();
  });

  it("refuses to start when a live process holds the lock", async () => {
    await writeFile(path, String(process.pid), "utf8");
    await expect(acquireLock(path)).rejects.toThrow(/already running/);
  });

  it("takes over a stale lock", async () => {
    await writeFile(path, "999999999", "utf8");
    await expect(acquireLock(path)).resolves.toBeUndefined();
  });
});

type FakeStdin = NodeJS.ReadStream & {
  setRawMode: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => boolean;
};

const fakeStdin = (isTTY: boolean): FakeStdin => {
  const stream = new EventEmitter() as unknown as FakeStdin;
  Object.assign(stream, {
    isTTY,
    setRawMode: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
  });
  return stream;
};

const stubDashboard = (): Dashboard & { footers: string[] } => {
  const footers: string[] = [];
  return {
    footers,
    run: async () => ({ workspaces: [], global: [] }),
    setFooter: (text) => {
      footers.push(text);
    },
    render: () => {},
    finish: () => {},
  };
};

// Real setImmediate turns, so real I/O (the lock file) settles even while the
// interval timers are faked.
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

// Polls for the observable state instead of spending a fixed number of turns:
// setImmediate callbacks can all batch in the check phase before the poll phase
// delivers the lock file's I/O, so a fixed budget is not enough under load.
const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let i = 0; i < 10_000; i++) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for condition");
};

const startDaemon = (options: {
  lockPath: string;
  runChecks: () => Promise<TickResults>;
  dashboard: Dashboard;
  stdin: FakeStdin;
}): Promise<void> => {
  const context = testContext();
  return runDaemon({
    context,
    state: context.state,
    runChecks: options.runChecks,
    present: async () => {},
    now: () => new Date(0),
    intervalSeconds: 60,
    lockPath: options.lockPath,
    logger: silentLogger,
    dashboard: options.dashboard,
    stdin: options.stdin,
  });
};

describe("daemon tick shortcut", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(os.tmpdir(), "paseo-watch-tick-"));
    lockPath = join(dir, "watch.lock");
    // The daemon registers SIGINT/SIGTERM handlers that are only removed when
    // it stops; swallow registration so tests that never stop it don't leak
    // listeners onto the shared process.
    vi.spyOn(process, "on").mockImplementation(() => process);
    vi.useFakeTimers({
      toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"],
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  const runChecks = (): Mock<() => Promise<TickResults>> =>
    vi.fn(async (): Promise<TickResults> => ({ workspaces: [], global: [] }));

  it("runs the next tick immediately when n is pressed", async () => {
    const checks = runChecks();
    const dashboard = stubDashboard();
    const stdin = fakeStdin(true);

    void startDaemon({ lockPath, runChecks: checks, dashboard, stdin });
    await waitFor(() => stdin.setRawMode.mock.calls.length === 1);

    expect(checks).toHaveBeenCalledTimes(1);
    expect(dashboard.footers.at(-1)).toContain("n to run now");

    stdin.emit("keypress", "n", { name: "n" });
    await waitFor(() => checks.mock.calls.length === 2);

    expect(checks).toHaveBeenCalledTimes(2);
  });

  it("ignores further presses while a tick is already starting", async () => {
    const checks = runChecks();
    const dashboard = stubDashboard();
    const stdin = fakeStdin(true);

    void startDaemon({ lockPath, runChecks: checks, dashboard, stdin });
    await waitFor(() => stdin.setRawMode.mock.calls.length === 1);
    expect(checks).toHaveBeenCalledTimes(1);

    stdin.emit("keypress", "n", { name: "n" });
    stdin.emit("keypress", "n", { name: "n" });
    await waitFor(() => checks.mock.calls.length === 2);

    expect(checks).toHaveBeenCalledTimes(2);
  });

  it("does not bind keys or advertise the shortcut without a TTY", async () => {
    const checks = runChecks();
    const dashboard = stubDashboard();
    const stdin = fakeStdin(false);

    void startDaemon({ lockPath, runChecks: checks, dashboard, stdin });
    await waitFor(() => dashboard.footers.length > 0);

    expect(stdin.setRawMode).not.toHaveBeenCalled();
    expect(dashboard.footers.at(-1)).not.toContain("n to run now");

    stdin.emit("keypress", "n", { name: "n" });
    await flush();

    expect(checks).toHaveBeenCalledTimes(1);
  });

  it("stops on ctrl-c while keys are bound", async () => {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as () => never);
    const checks = runChecks();
    const dashboard = stubDashboard();
    const stdin = fakeStdin(true);

    void startDaemon({ lockPath, runChecks: checks, dashboard, stdin });
    await waitFor(() => stdin.setRawMode.mock.calls.length === 1);

    stdin.emit("keypress", "\u0003", { name: "c", ctrl: true });
    await waitFor(() => exit.mock.calls.length > 0);

    expect(exit).toHaveBeenCalledWith(0);
  });
});
