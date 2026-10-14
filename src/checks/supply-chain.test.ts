import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUPPLY_CHAIN_INCIDENT_LABEL } from "../labels.ts";
import { testConfig, testContext, workspace } from "../test-helpers.ts";
import type { CheckContext } from "../types.ts";
import { createSupplyChainCheck } from "./supply-chain.ts";

const MAIN_ID = "wks_main";

const CLOUDFLARE_INCIDENT = {
  name: "DNS resolver issues in SIN",
  impact: "minor",
  shortlink: "https://www.cloudflarestatus.com/incidents/1",
};

const CIRCLE_INCIDENT = {
  name: "Delayed builds",
  impact: "minor",
  shortlink: "https://status.circleci.com/incidents/2",
};

const CLOUDFLARE_SECOND = {
  name: "Gateway DNS issues",
  impact: "minor",
  shortlink: "https://www.cloudflarestatus.com/incidents/3",
};

/**
 * Answers every provider as operational unless its host is given incidents or
 * is listed as unreachable.
 */
const stubProviders = (
  incidentsByHost: Record<string, unknown[]> = {},
  unreachableHosts: string[] = [],
): void => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const host = new URL(url).host;
      if (unreachableHosts.includes(host)) {
        return { ok: false, status: 503, text: async () => "down" };
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ incidents: incidentsByHost[host] ?? [] }),
      };
    }),
  );
};

describe("supply-chain check", () => {
  let home: string;
  let statePath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(os.tmpdir(), "paseo-supply-"));
    statePath = join(home, "projects", "workspaces.json");
    await mkdir(join(home, "projects"), { recursive: true });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true });
  });

  const writeLabels = (labels: string[]) =>
    writeFile(statePath, JSON.stringify([{ workspaceId: MAIN_ID, labels }]));

  const readLabels = async (): Promise<string[]> => {
    const entries = JSON.parse(await readFile(statePath, "utf8")) as Array<{
      labels?: string[];
    }>;
    return entries[0]?.labels ?? [];
  };

  const contextFor = (labels: string[] = [], dryRun = false): CheckContext =>
    testContext({
      workspaces: [
        workspace({ id: MAIN_ID, name: "main", cwd: "/repo", labels }),
      ],
      config: testConfig({ paseoHome: home, dryRun }),
    });

  it("reports Operational and leaves the label absent when all providers are up", async () => {
    stubProviders();
    await writeLabels([]);

    const result = await createSupplyChainCheck().run(contextFor([]));

    expect(result).toMatchObject({
      status: "ok",
      label: "Operational",
    });
    expect(await readLabels()).toEqual([]);
  });

  it("names the providers with incidents and adds the label", async () => {
    stubProviders({ "www.cloudflarestatus.com": [CLOUDFLARE_INCIDENT] });
    await writeLabels([]);

    const result = await createSupplyChainCheck().run(contextFor([]));

    expect(result.status).toBe("error");
    expect(result.label).toBe("Cloudflare");
    expect(result.detail).toContain("DNS resolver issues in SIN");
    expect(await readLabels()).toEqual([SUPPLY_CHAIN_INCIDENT_LABEL]);
  });

  it("lists every provider with an incident", async () => {
    stubProviders({
      "www.cloudflarestatus.com": [CLOUDFLARE_INCIDENT],
      "status.circleci.com": [CIRCLE_INCIDENT],
    });
    await writeLabels([]);

    const result = await createSupplyChainCheck().run(contextFor([]));

    expect(result.label).toBe("Cloudflare, CircleCI");
  });

  it("puts each incident on its own line", async () => {
    stubProviders({
      "www.cloudflarestatus.com": [CLOUDFLARE_INCIDENT, CLOUDFLARE_SECOND],
    });
    await writeLabels([]);

    const result = await createSupplyChainCheck().run(contextFor([]));

    expect(result.detail.split("\n")).toEqual([
      "Cloudflare: DNS resolver issues in SIN",
      "Cloudflare: Gateway DNS issues",
      "label added",
    ]);
  });

  it("leaves the label alone when an incident is already flagged", async () => {
    stubProviders({ "status.circleci.com": [CIRCLE_INCIDENT] });
    await writeLabels([SUPPLY_CHAIN_INCIDENT_LABEL]);

    const result = await createSupplyChainCheck().run(
      contextFor([SUPPLY_CHAIN_INCIDENT_LABEL]),
    );

    expect(result.label).toBe("CircleCI");
    expect(result.detail).not.toContain("label added");
    expect(await readLabels()).toEqual([SUPPLY_CHAIN_INCIDENT_LABEL]);
  });

  it("removes the label once every incident clears", async () => {
    stubProviders();
    await writeLabels([SUPPLY_CHAIN_INCIDENT_LABEL, "keep-me"]);

    const result = await createSupplyChainCheck().run(
      contextFor([SUPPLY_CHAIN_INCIDENT_LABEL, "keep-me"]),
    );

    expect(result.status).toBe("ok");
    expect(result.detail).toContain("label removed");
    expect(await readLabels()).toEqual(["keep-me"]);
  });

  it("leaves the label untouched when a status page is unreachable", async () => {
    stubProviders({}, ["www.githubstatus.com"]);
    await writeLabels([SUPPLY_CHAIN_INCIDENT_LABEL]);

    const result = await createSupplyChainCheck().run(
      contextFor([SUPPLY_CHAIN_INCIDENT_LABEL]),
    );

    expect(result).toMatchObject({ status: "error", label: "Unreachable" });
    expect(result.detail).toContain("GitHub");
    expect(await readLabels()).toEqual([SUPPLY_CHAIN_INCIDENT_LABEL]);
  });

  it("still flags an incident when another page is unreachable", async () => {
    stubProviders({ "www.cloudflarestatus.com": [CLOUDFLARE_INCIDENT] }, [
      "www.githubstatus.com",
    ]);
    await writeLabels([]);

    const result = await createSupplyChainCheck().run(contextFor([]));

    expect(result.status).toBe("error");
    expect(result.label).toBe("Cloudflare");
    expect(result.detail).toContain("Unreachable: GitHub");
    expect(await readLabels()).toEqual([SUPPLY_CHAIN_INCIDENT_LABEL]);
  });

  it("reports without writing on a dry run", async () => {
    stubProviders({ "www.cloudflarestatus.com": [CLOUDFLARE_INCIDENT] });
    await writeLabels([]);

    const result = await createSupplyChainCheck().run(contextFor([], true));

    expect(result.detail).toContain("would add the label");
    expect(await readLabels()).toEqual([]);
  });

  it("reports when there is no main workspace to label", async () => {
    stubProviders();

    const result = await createSupplyChainCheck().run(
      testContext({
        workspaces: [workspace({ name: "TASK-1: Example" })],
        config: testConfig({ paseoHome: home }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(result.detail).toContain("no main workspace");
  });
});
