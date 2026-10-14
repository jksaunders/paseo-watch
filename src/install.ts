import type { CheckContext, CheckDecision, Run } from "./types.ts";

type InstallOutcome = { ok: true } | { ok: false; detail: string };

export const installDependencies = async (
  run: Run,
  cwd: string,
): Promise<InstallOutcome> => {
  const result = await run("pnpm", ["install", "--frozen-lockfile"], { cwd });
  return result.code === 0
    ? { ok: true }
    : {
        ok: false,
        detail: result.stderr.trim() || `pnpm install exited ${result.code}`,
      };
};

/**
 * Install dependencies for a cwd, keeping it queued for a retry if the install
 * fails. A cwd is only stamped when first queued so a permanently broken install
 * still ages out of state instead of retrying forever.
 */
export const installNow = async (
  context: CheckContext,
  cwd: string,
): Promise<InstallOutcome> => {
  if (context.state.installs[cwd] === undefined) {
    context.state.installs[cwd] = new Date(context.now()).toISOString();
  }
  const outcome = await installDependencies(context.run, cwd);
  if (outcome.ok) delete context.state.installs[cwd];
  return outcome;
};

/**
 * Run a queued install for a cwd, if one is waiting. Returns null when nothing
 * is queued so callers can fall through to their own up-to-date result.
 */
export const runQueuedInstall = async (
  context: CheckContext,
  cwd: string,
): Promise<CheckDecision | null> => {
  if (context.state.installs[cwd] === undefined) return null;
  if (context.config.dryRun) {
    return {
      status: "action",
      detail: "would install dependencies",
      label: "to install",
    };
  }
  const install = await installNow(context, cwd);
  if (!install.ok) {
    return { status: "error", detail: install.detail, label: "install failed" };
  }
  return {
    status: "action",
    detail: "installed dependencies",
    label: "installed",
  };
};
