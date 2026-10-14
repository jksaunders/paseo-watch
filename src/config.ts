import { parseArgs } from "node:util";
import type { Config } from "./types.ts";

export const DEFAULT_REPO = "<repo slug here>";
export const DEFAULT_INTERVAL_SECONDS = 60;
export const DEFAULT_DEBOUNCE_SECONDS = 120;
const DEFAULT_SKIP_LABELS = ["skip-updates"];

type Command = "daemon" | "once" | "status";

const COMMANDS: readonly Command[] = ["daemon", "once", "status"];

export type CliFlags = {
  interval?: number;
  debounce?: number;
  dryRun: boolean;
  verbose: boolean;
  state?: string;
};

export type Cli = {
  command: Command;
  config: Config;
  help: boolean;
};

const USAGE = `Usage: paseo-watch [command] [flags]

Commands:
  daemon   Run continuously, ticking every --interval seconds (default)
  once     Run a single tick and exit
  status   Print the current status of every check and exit

Flags:
  --interval <seconds>   Seconds between ticks (default ${DEFAULT_INTERVAL_SECONDS})
  --debounce <seconds>   Minimum age of a tip commit before it is pushed (default ${DEFAULT_DEBOUNCE_SECONDS})
  --dry-run              Report what would happen without pushing or prompting
  --state <path>         Override the JSON state file location
  --verbose              Log extra diagnostics
  -h, --help             Show this help`;

export const usage = (): string => USAGE;

export const parsePositiveSeconds = (value: string, flag: string): number => {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(`--${flag} must be a positive whole number of seconds.`);
  }
  return seconds;
};

const isCommand = (value: string): value is Command =>
  (COMMANDS as readonly string[]).includes(value);

export const parseCli = (
  argv: string[],
  env: NodeJS.ProcessEnv,
  home: string,
): Cli => {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      interval: { type: "string" },
      debounce: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      state: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  const [command = "daemon", ...rest] = positionals;
  if (!isCommand(command)) {
    throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
  }
  if (rest.length > 0) {
    throw new Error(`Unexpected arguments: ${rest.join(" ")}\n\n${USAGE}`);
  }

  const flags: CliFlags = {
    interval:
      values.interval === undefined
        ? undefined
        : parsePositiveSeconds(values.interval, "interval"),
    debounce:
      values.debounce === undefined
        ? undefined
        : parsePositiveSeconds(values.debounce, "debounce"),
    dryRun: values["dry-run"] ?? false,
    verbose: values.verbose ?? false,
    state: values.state,
  };

  return {
    command,
    config: resolveConfig({ env, home, flags }),
    help: values.help ?? false,
  };
};

export const resolveConfig = ({
  env,
  home,
  flags,
}: {
  env: NodeJS.ProcessEnv;
  home: string;
  flags: CliFlags;
}): Config => {
  const repo = env.PASEO_WATCH_REPO ?? DEFAULT_REPO;
  const paseoHome = env.PASEO_HOME ?? `${home}/.paseo`;
  return {
    intervalSeconds: flags.interval ?? DEFAULT_INTERVAL_SECONDS,
    debounceSeconds: flags.debounce ?? DEFAULT_DEBOUNCE_SECONDS,
    dryRun: flags.dryRun,
    verbose: flags.verbose,
    repo,
    circleciProject: env.PASEO_WATCH_CIRCLECI_PROJECT ?? `gh/${repo}`,
    paseoHome,
    paseoCli: env.PASEO_CLI ?? "paseo",
    provider: env.PASEO_PROVIDER ?? "",
    planeApiKey: env.PLANE_API_KEY ?? "",
    statePath: flags.state ?? `${paseoHome}/runtime/paseo-watch/state.json`,
    skipLabels: [...DEFAULT_SKIP_LABELS],
  };
};
