import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEBOUNCE_SECONDS,
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_REPO,
  parseCli,
  parsePositiveSeconds,
  resolveConfig,
  usage,
} from "./config.ts";

const HOME = "/home/u";

describe("resolveConfig", () => {
  it("applies defaults", () => {
    const config = resolveConfig({
      env: {},
      home: HOME,
      flags: { dryRun: false, verbose: false },
    });

    expect(config).toEqual({
      intervalSeconds: DEFAULT_INTERVAL_SECONDS,
      debounceSeconds: DEFAULT_DEBOUNCE_SECONDS,
      dryRun: false,
      verbose: false,
      repo: DEFAULT_REPO,
      circleciProject: `gh/${DEFAULT_REPO}`,
      paseoHome: `${HOME}/.paseo`,
      paseoCli: "paseo",
      provider: "",
      planeApiKey: "",
      statePath: `${HOME}/.paseo/runtime/paseo-watch/state.json`,
      skipLabels: ["skip-updates"],
    });
  });

  it("reads environment overrides", () => {
    const config = resolveConfig({
      env: {
        PASEO_HOME: "/custom/paseo",
        PASEO_CLI: "/apps/paseo",
        PASEO_WATCH_REPO: "octo/repo",
        PASEO_WATCH_CIRCLECI_PROJECT: "gh/octo/repo",
        PLANE_API_KEY: "plane_api_test",
      },
      home: HOME,
      flags: { dryRun: false, verbose: false },
    });

    expect(config.paseoHome).toBe("/custom/paseo");
    expect(config.paseoCli).toBe("/apps/paseo");
    expect(config.planeApiKey).toBe("plane_api_test");
    expect(config.circleciProject).toBe("gh/octo/repo");
    expect(config.statePath).toBe(
      "/custom/paseo/runtime/paseo-watch/state.json",
    );
  });

  it("describes every command and flag in the usage text", () => {
    const text = usage();
    for (const command of ["daemon", "once", "status"]) {
      expect(text).toContain(command);
    }
    expect(text).toContain("--dry-run");
  });
});

describe("parsePositiveSeconds", () => {
  it("accepts positive whole numbers", () => {
    expect(parsePositiveSeconds("30", "interval")).toBe(30);
  });

  it.each(["0", "-5", "1.5", "abc", ""])("rejects %j", (value) => {
    expect(() => parsePositiveSeconds(value, "interval")).toThrow(/interval/);
  });
});

describe("parseCli", () => {
  it("defaults to the daemon command", () => {
    const cli = parseCli([], {}, HOME);
    expect(cli.command).toBe("daemon");
    expect(cli.help).toBe(false);
    expect(cli.config.intervalSeconds).toBe(DEFAULT_INTERVAL_SECONDS);
  });

  it.each(["daemon", "once", "status"])("accepts the %s command", (command) => {
    expect(parseCli([command], {}, HOME).command).toBe(command);
  });

  it("parses flags and env together", () => {
    const cli = parseCli(
      [
        "once",
        "--interval",
        "15",
        "--debounce",
        "5",
        "--dry-run",
        "--state",
        "/x/state.json",
      ],
      { PASEO_HOME: "/env/paseo" },
      HOME,
    );

    expect(cli.command).toBe("once");
    expect(cli.config.intervalSeconds).toBe(15);
    expect(cli.config.debounceSeconds).toBe(5);
    expect(cli.config.dryRun).toBe(true);
    expect(cli.config.paseoHome).toBe("/env/paseo");
    expect(cli.config.statePath).toBe("/x/state.json");
  });

  it("supports the verbose and help flags", () => {
    const cli = parseCli(["--verbose", "-h"], {}, HOME);
    expect(cli.config.verbose).toBe(true);
    expect(cli.help).toBe(true);
  });

  it("rejects an unknown command", () => {
    expect(() => parseCli(["watch"], {}, HOME)).toThrow(/Unknown command/);
  });

  it("rejects stray positionals", () => {
    expect(() => parseCli(["once", "extra"], {}, HOME)).toThrow(
      /Unexpected arguments/,
    );
  });

  it("rejects a bad interval", () => {
    expect(() => parseCli(["--interval", "nope"], {}, HOME)).toThrow(
      /interval/,
    );
  });
});
