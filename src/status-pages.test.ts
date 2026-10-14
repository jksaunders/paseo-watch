import { describe, expect, it, vi } from "vitest";
import {
  fetchProviderStatuses,
  type HttpFetch,
  SUPPLY_CHAIN_PROVIDERS,
  type SupplyChainProvider,
} from "./status-pages.ts";

const provider: SupplyChainProvider = {
  name: "Acme",
  baseUrl: "https://status.example.com",
};

const ok = (body: unknown) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
});

const incident = {
  name: "API is down",
  impact: "major",
  shortlink: "https://status.example.com/incidents/1",
};

describe("fetchProviderStatuses", () => {
  it("reports a provider with no unresolved incidents as ok", async () => {
    const statuses = await fetchProviderStatuses({
      fetchFn: vi.fn(async () => ok({ incidents: [] })),
      providers: [provider],
    });

    expect(statuses).toEqual([{ name: "Acme", kind: "ok" }]);
  });

  it("reports unresolved incidents by name and ignores extra fields", async () => {
    const statuses = await fetchProviderStatuses({
      fetchFn: vi.fn(async () => ok({ incidents: [incident] })),
      providers: [provider],
    });

    expect(statuses).toEqual([
      {
        name: "Acme",
        kind: "incident",
        incidents: [{ name: "API is down" }],
      },
    ]);
  });

  it("queries the unresolved-incidents endpoint", async () => {
    const calls: string[] = [];
    const fetchFn: HttpFetch = vi.fn(async (url) => {
      calls.push(url);
      return ok({ incidents: [] });
    });

    await fetchProviderStatuses({ fetchFn, providers: [provider] });

    expect(calls).toEqual([
      "https://status.example.com/api/v2/incidents/unresolved.json",
    ]);
  });

  it("reports a non-200 response as an error", async () => {
    const statuses = await fetchProviderStatuses({
      fetchFn: vi.fn(async () => ({
        ok: false,
        status: 503,
        text: async () => "unavailable",
      })),
      providers: [provider],
    });

    expect(statuses).toEqual([
      { name: "Acme", kind: "error", detail: "Status page returned 503" },
    ]);
  });

  it("reports malformed JSON as an error", async () => {
    const statuses = await fetchProviderStatuses({
      fetchFn: vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => "not json",
      })),
      providers: [provider],
    });

    expect(statuses[0]).toMatchObject({ name: "Acme", kind: "error" });
  });

  it("reports an unexpected payload as an error with a concise detail", async () => {
    const statuses = await fetchProviderStatuses({
      fetchFn: vi.fn(async () => ok({ incidents: [{ missingName: true }] })),
      providers: [provider],
    });

    expect(statuses).toEqual([
      {
        name: "Acme",
        kind: "error",
        detail: "Status page returned an unexpected payload",
      },
    ]);
  });

  it("passes an abort signal so a stalled page cannot hang the check", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const fetchFn: HttpFetch = vi.fn(async (_url, init) => {
      signals.push(init.signal);
      return ok({ incidents: [] });
    });

    await fetchProviderStatuses({ fetchFn, providers: [provider] });

    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("isolates a provider whose fetch throws", async () => {
    const other: SupplyChainProvider = {
      name: "Beta",
      baseUrl: "https://beta.example.com",
    };
    const statuses = await fetchProviderStatuses({
      fetchFn: vi.fn(async (url) => {
        if (url.includes("beta")) throw new Error("offline");
        return ok({ incidents: [] });
      }),
      providers: [provider, other],
    });

    expect(statuses).toEqual([
      { name: "Acme", kind: "ok" },
      { name: "Beta", kind: "error", detail: "offline" },
    ]);
  });

  it("includes npm among the default supply-chain providers", () => {
    expect(SUPPLY_CHAIN_PROVIDERS.map((entry) => entry.name)).toEqual([
      "GitHub",
      "Cloudflare",
      "CircleCI",
      "npm",
    ]);
  });
});
