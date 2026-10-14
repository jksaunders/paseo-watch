# paseo-watch

A tiny daemon that runs alongside [Paseo](https://paseo.sh) and periodically
checks each workspace (git worktree), then nudges an agent when something needs
doing: pull the latest main, merge main into a branch, push an unpushed commit,
resolve failing CI, merge a ready PR, and more.

Point your agent at this repo and let it rewrite the checks for your own ADE
(Orca, Conductor, etc.) and workflows.

## Requirements

- Node.js **>= 24** (the CLI is executed directly from TypeScript via Node's
  native type stripping, so there is no build step).
- [pnpm](https://pnpm.io) 12.x.
- A local [Paseo](https://paseo.sh) install (`~/.paseo` by default) with one or
  more workspaces.
- Optional: the `gh`, `git`, and `circleci` CLIs on `PATH` for the checks that
  shell out to them.

## Setup

```sh
pnpm install
cp .env.example .env   # then fill in any tokens you need
```

## Usage

```sh
pnpm start                     # run the daemon (tick every 60s)
pnpm daemon                    # same as start
pnpm once                      # run a single tick and exit
pnpm status                    # print the status of every check and exit

# or invoke the CLI directly
node src/main.ts [command] [flags]
```

### Commands

| Command  | Description                                                |
| -------- | ---------------------------------------------------------- |
| `daemon` | Run continuously, ticking every `--interval` seconds (default). |
| `once`   | Run a single tick and exit.                                |
| `status` | Print the current status of every check and exit (dry run). |

### Flags

| Flag                   | Description                                                        |
| ---------------------- | ------------------------------------------------------------------ |
| `--interval <seconds>` | Seconds between ticks (default `60`).                              |
| `--debounce <seconds>` | Minimum age of a tip commit before it is pushed (default `120`).   |
| `--dry-run`            | Report what would happen without pushing or prompting.             |
| `--state <path>`       | Override the JSON state file location.                             |
| `--verbose`            | Log extra diagnostics.                                             |
| `-h`, `--help`         | Show help.                                                         |

## Configuration

Configuration is read from the environment (and the package-local `.env` file,
loaded on start).

| Variable                        | Default                          | Purpose                                                        |
| ------------------------------- | -------------------------------- | -------------------------------------------------------------- |
| `PASEO_HOME`                    | `~/.paseo`                       | Paseo home; workspace metadata and runtime state live here.    |
| `PASEO_CLI`                     | `paseo`                          | The Paseo CLI binary to invoke.                                |
| `PASEO_PROVIDER`                | _(empty)_                        | Provider passed to started agents.                             |
| `PASEO_WATCH_REPO`              | `<repo slug here>`               | `owner/name` of the repo the checks target.                    |
| `PASEO_WATCH_CIRCLECI_PROJECT`  | `gh/<repo>`                      | CircleCI project slug used for CI failure reports.             |
| `PLANE_API_KEY`                 | _(empty)_                        | Plane personal access token for the Plane/PR check.            |

## Checks

Each tick fans out over every Paseo workspace and runs the workspace checks in
parallel, plus one global check.

| Check           | Column    | What it does                                                                 |
| --------------- | --------- | ---------------------------------------------------------------------------- |
| `pull`          | pull      | Fast-forwards main and, after a pull, runs `pnpm install` if deps changed.   |
| `mergeMain`     | merge     | Merges main into a feature branch, aborting cleanly on conflicts.            |
| `unpushed`      | push      | Pushes a debounced tip commit once it is old enough.                         |
| `status`        | checks    | Watches GitHub commit statuses; briefs an agent when CI fails.               |
| `planePrLink`   | Plane     | Ensures the PR carries the work-item ref and moves it to review.             |
| `mergeWhenReady`| merge     | Merges a PR labelled `merge-when-ready` once checks pass.                    |
| `quality`       | quality   | Runs a review/quality pass after the `ready-for-quality` label.              |
| `supplyChain`   | _global_  | Watches provider status pages (GitHub, Cloudflare, CircleCI, npm).           |

## Project layout

```
src/
  main.ts            CLI entrypoint: parse args, wire up checks, run.
  config.ts          CLI parsing and environment-based configuration.
  daemon.ts          The tick loop, lockfile, and keyboard shortcuts.
  tick.ts            A single tick: run checks, present results, persist state.
  discovery.ts       Discover Paseo workspaces and running agents.
  workspaces.ts      Parse Paseo workspace/agent metadata and labels.
  agent.ts           Start a Paseo agent for a workspace.
  git.ts             git helpers (branch state, pull, merge, push).
  github.ts          GitHub PR and commit-status helpers.
  circleci.ts        CircleCI failure reports.
  plane.ts           Plane work-item lookups and PR footer links.
  status-pages.ts    Provider status-page polling.
  state.ts           Persistent per-workspace/PR state (zod-validated JSON).
  labels.ts          Read/write Paseo workspace labels.
  install.ts         Dependency install queue for pull/merge.
  self.ts            Detect when the watcher's own code changed.
  pool.ts            Bounded-concurrency helper.
  types.ts           Shared types.
  checks/            One module per check.
  ui/                Terminal dashboard, table, formatting, and ANSI helpers.
```

## Scripts

| Script               | Description                            |
| -------------------- | -------------------------------------- |
| `pnpm check-types`   | `tsc --noEmit`.                        |
| `pnpm test`          | Run the Vitest suite once.             |
| `pnpm test:watch`    | Run Vitest in watch mode.              |
| `pnpm test:coverage` | Run tests with coverage thresholds.    |
| `pnpm lint`          | Biome check.                           |
| `pnpm format`        | Biome check with `--write`.            |

## Adapting this repo

This is a reference implementation extracted from a specific setup. The parts
most people will want to rewrite for their own ADE and repos:

- **The check list** in `src/main.ts` — add, remove, or reorder checks.
- **Project-specific constants** (shipped as placeholders — replace them):
  - `DEFAULT_REPO` in `src/config.ts` (default `<repo slug here>`, also
    overridable via `PASEO_WATCH_REPO`).
  - `PLANE_WORKSPACE_SLUG` (`<plane workplace slug here>`) and
    `PROJECT_IDENTIFIER` (`<project identifier here>`) in `src/plane.ts`.
  - `SUPPLY_CHAIN_PROVIDERS` in `src/status-pages.ts`.
- **Workspace discovery** in `src/discovery.ts` / `src/workspaces.ts` if your
  ADE stores workspace metadata differently from Paseo.
- **Agent startup** in `src/agent.ts` to match how your ADE launches agents.

## Tests

```sh
pnpm test
```

The suite uses [Vitest](https://vitest.dev) and covers every check plus the
daemon, discovery, state, and UI helpers.
