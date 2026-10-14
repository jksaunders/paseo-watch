import type { ExecFileException } from "node:child_process";
import { execFile } from "node:child_process";
import type { Logger, Run, RunResult } from "./types.ts";

const MAX_BUFFER = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MISSING_COMMAND_CODE = 127;
const TIMEOUT_CODE = 124;

const exitCodeOf = (error: ExecFileException | null): number => {
  if (!error) return 0;
  if (typeof error.code === "number") return error.code;
  if (error.killed || error.signal) return TIMEOUT_CODE;
  return MISSING_COMMAND_CODE;
};

export const createRun = (settings: { timeoutMs?: number } = {}): Run => {
  const timeout = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (command, args, options = {}) =>
    new Promise<RunResult>((resolve) => {
      execFile(
        command,
        args,
        { cwd: options.cwd, encoding: "utf8", maxBuffer: MAX_BUFFER, timeout },
        (error, stdout, stderr) => {
          resolve({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            code: exitCodeOf(error),
          });
        },
      );
    });
};

export const createLogger = (verbose: boolean): Logger => ({
  info: (message) => process.stdout.write(`${message}\n`),
  warn: (message) => process.stderr.write(`${message}\n`),
  error: (message) => process.stderr.write(`${message}\n`),
  debug: (message) => {
    if (verbose) process.stderr.write(`[debug] ${message}\n`);
  },
});

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};
