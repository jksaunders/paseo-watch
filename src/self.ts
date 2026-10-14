import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Run } from "./types.ts";

/** The running package's directory, i.e. the repo root in this checkout. */
export const SELF_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Only runtime files force a restart: the watcher's `src` sources (tests and
 * the test helper aren't loaded) and its `package.json` (deps may have moved).
 *
 * `packagePrefix` is the watcher package's path relative to the repo root. It
 * is empty when the watcher sits at the repo root (as in this reference repo)
 * and a directory such as `packages/paseo-watch` when it is embedded in a
 * monorepo.
 */
const isRuntimeChange = (path: string, packagePrefix: string): boolean => {
  const prefix = packagePrefix === "" ? "" : `${packagePrefix}/`;
  if (path === `${prefix}package.json`) return true;
  if (!path.startsWith(`${prefix}src/`)) return false;
  if (path.endsWith(".test.ts") || path.endsWith("/test-helpers.ts")) {
    return false;
  }
  return true;
};

export const selfChanged = (
  changedPaths: string[],
  repoRoot: string,
  selfDir: string,
): boolean => {
  const rel = relative(repoRoot, selfDir);
  if (rel.startsWith("..")) return false;
  return changedPaths.some((path) => isRuntimeChange(path, rel));
};

/**
 * After a pull, report whether the watcher's own code moved. A running process
 * keeps the module graph it started with, so this is a hint to restart.
 */
export const restartNotice = async (
  run: Run,
  cwd: string,
  changed: string[] | null,
): Promise<string | undefined> => {
  if (changed === null) return undefined;

  const toplevel = await run("git", [
    "-C",
    cwd,
    "rev-parse",
    "--show-toplevel",
  ]);
  if (toplevel.code !== 0) return undefined;

  return selfChanged(changed, toplevel.stdout.trim(), SELF_DIR)
    ? "restart to pick up new watcher code"
    : undefined;
};
