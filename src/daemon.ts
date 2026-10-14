import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";
import * as readline from "node:readline";
import { runTick, type TickDeps } from "./tick.ts";
import type { Logger } from "./types.ts";
import type { Dashboard } from "./ui/dashboard.ts";

const EXISTING_LOCK = "EEXIST";
const NEXT_TICK_KEY = "n";

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const acquireLock = async (path: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, String(process.pid), { flag: "wx" });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== EXISTING_LOCK) throw error;
  }

  const existing = Number(await readFile(path, "utf8").catch(() => ""));
  if (Number.isInteger(existing) && existing > 0 && isAlive(existing)) {
    throw new Error(
      `Another paseo-watch is already running (pid ${existing}).`,
    );
  }
  await writeFile(path, String(process.pid));
};

export const releaseLock = async (path: string): Promise<void> => {
  await rm(path, { force: true });
};

export const runDaemon = async (
  deps: TickDeps & {
    intervalSeconds: number;
    lockPath: string;
    logger: Logger;
    dashboard: Dashboard;
    stdin?: NodeJS.ReadStream;
  },
): Promise<void> => {
  await acquireLock(deps.lockPath);

  const stdin = deps.stdin ?? process.stdin;
  const interactive = stdin.isTTY === true;
  let tickTimer: NodeJS.Timeout | undefined;
  let countdownTimer: NodeJS.Timeout | undefined;
  let detachKeys: (() => void) | undefined;
  let stopping = false;

  const clearTimers = (): void => {
    if (tickTimer) clearTimeout(tickTimer);
    if (countdownTimer) clearInterval(countdownTimer);
    tickTimer = undefined;
    countdownTimer = undefined;
  };

  const releaseKeys = (): void => {
    detachKeys?.();
    detachKeys = undefined;
  };

  const footer = (remaining: number): string => {
    const shortcut = interactive ? `${NEXT_TICK_KEY} to run now · ` : "";
    return `next tick in ${remaining}s · ${shortcut}ctrl-c to stop`;
  };

  const attachKeys = (): void => {
    if (!interactive || detachKeys) return;
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    const onKeypress = (_chunk: string, key: readline.Key): void => {
      if (key.ctrl && key.name === "c") {
        void stop();
        return;
      }
      if (!key.ctrl && !key.meta && key.name === NEXT_TICK_KEY) tickNow();
    };
    stdin.on("keypress", onKeypress);
    detachKeys = () => {
      stdin.off("keypress", onKeypress);
      stdin.setRawMode(false);
      stdin.pause();
    };
  };

  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    clearTimers();
    releaseKeys();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await releaseLock(deps.lockPath);
    process.exit(0);
  }

  function onSignal(): void {
    void stop();
  }

  function tickNow(): void {
    if (tickTimer === undefined || stopping) return;
    clearTimers();
    releaseKeys();
    void tick();
  }

  async function tick(): Promise<void> {
    try {
      await runTick(deps);
    } catch (error) {
      deps.logger.error(
        `Tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (stopping) return;

    let remaining = deps.intervalSeconds;
    deps.dashboard.setFooter(footer(remaining));
    deps.dashboard.render();
    countdownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        if (countdownTimer) clearInterval(countdownTimer);
        return;
      }
      deps.dashboard.setFooter(footer(remaining));
      deps.dashboard.render();
    }, 1000);

    tickTimer = setTimeout(tickNow, deps.intervalSeconds * 1000);
    attachKeys();
  }

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  await tick();
  await new Promise(() => {});
};
