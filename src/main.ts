#!/usr/bin/env node
import os from "node:os";
import { join } from "node:path";
import process from "node:process";
import { startWorkspaceAgent } from "./agent.ts";
import { createPlanePrLinkCheck } from "./checks/link-pr.ts";
import { createMergeMainCheck } from "./checks/merge-main.ts";
import { createMergeWhenReadyCheck } from "./checks/merge-when-ready.ts";
import { createPullCheck } from "./checks/pull.ts";
import { createQualityCheck } from "./checks/quality.ts";
import { createStatusCheck } from "./checks/status.ts";
import { createSupplyChainCheck } from "./checks/supply-chain.ts";
import { createUnpushedCheck } from "./checks/unpushed.ts";
import { parseCli, usage } from "./config.ts";
import { runDaemon } from "./daemon.ts";
import { discover, discoverRunningAgents } from "./discovery.ts";
import { refreshRemotes } from "./git.ts";
import { createLogger, createRun } from "./run.ts";
import { SELF_DIR } from "./self.ts";
import { loadState, saveState } from "./state.ts";
import { runTick } from "./tick.ts";
import type { CheckContext, CheckResult, TickResults } from "./types.ts";
import { createDashboard } from "./ui/dashboard.ts";
import { presentEvents } from "./ui/events.ts";
import { createScreen } from "./ui/screen.ts";

const loadEnv = (): void => {
  try {
    process.loadEnvFile(join(SELF_DIR, ".env"));
  } catch {
    // No package-local .env; fall back to the ambient environment.
  }
};

const main = async (): Promise<void> => {
  loadEnv();
  const cli = parseCli(process.argv.slice(2), process.env, os.homedir());
  if (cli.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const config =
    cli.command === "status" ? { ...cli.config, dryRun: true } : cli.config;
  const logger = createLogger(config.verbose);
  const run = createRun();

  const { workspaces } = await discover(config, run);
  const state = await loadState(config.statePath);
  const context: CheckContext = {
    config,
    workspaces,
    runningCwds: new Set(),
    runningAgentIds: new Set(),
    run,
    state,
    now: () => Date.now(),
  };
  const checks = [
    createPullCheck(),
    createMergeMainCheck(),
    createUnpushedCheck(),
    createStatusCheck(),
    createPlanePrLinkCheck(),
    createMergeWhenReadyCheck(),
    createQualityCheck(),
  ];
  const globalChecks = [createSupplyChainCheck()];
  const persist = config.dryRun
    ? undefined
    : (): Promise<void> => saveState(config.statePath, state);

  const screen = createScreen(process.stdout);
  const dashboard = createDashboard({ checks, globalChecks, context, screen });

  const eventBrief = (
    event: CheckResult,
  ): { title: string; prompt: string } => {
    if (event.eventKind === "needs-review") {
      return {
        title: `Needs review: ${event.target}`,
        prompt: "/needs-review",
      };
    }
    if (event.eventKind === "merge-when-ready") {
      return {
        title: `Done: ${event.target}`,
        prompt: "/done",
      };
    }
    if (event.eventKind === "merge-main") {
      return {
        title: `Merge main: ${event.target}`,
        prompt: "Merge main and resolve any conflicts.",
      };
    }
    if (event.eventKind === "circleci") {
      return {
        title: `Resolve CircleCI: ${event.target}`,
        prompt: `CircleCI failed for this branch. Investigate and fix it.\n\n${event.detail}`,
      };
    }
    return {
      title: `Resolve status checks: ${event.target}`,
      prompt: `Commit status checks failed for this branch. Investigate and fix it.\n\n${event.detail}`,
    };
  };

  const present = async (results: TickResults): Promise<void> => {
    screen.clear();
    await presentEvents({
      results: results.workspaces,
      state,
      dryRun: config.dryRun,
      now: () => new Date(),
      logger,
      startAgent: (event) => {
        const workspaceId = event.workspaceId ?? "";
        return startWorkspaceAgent(run, {
          paseoCli: config.paseoCli,
          provider: config.provider,
          workspaceId,
          workspaceCwd: context.workspaces.find(
            (workspace) => workspace.id === workspaceId,
          )?.cwd,
          ...eventBrief(event),
        });
      },
    });
    screen.reset();
  };

  const deps = {
    context,
    state,
    persist,
    present,
    runChecks: dashboard.run,
    refresh: () => {
      const cwd = context.workspaces[0]?.cwd;
      return cwd ? refreshRemotes(run, cwd) : Promise.resolve();
    },
    refreshWorkspaces: async () => (await discover(config, run)).workspaces,
    refreshRunningAgents: () => discoverRunningAgents(config, run),
    now: () => new Date(),
  };

  if (cli.command === "daemon") {
    await runDaemon({
      ...deps,
      intervalSeconds: config.intervalSeconds,
      lockPath: `${config.paseoHome}/runtime/paseo-watch/watch.lock`,
      logger,
      dashboard,
    });
    return;
  }

  const results = await runTick(deps);
  const failed = [...results.workspaces, ...results.global].filter(
    (result) => result.status === "error",
  ).length;
  dashboard.setFooter(
    failed > 0 ? `done · ${failed} error(s)` : "done · every check passed",
  );
  dashboard.finish();
};

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
