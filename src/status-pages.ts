import { z } from "zod";

export type SupplyChainProvider = { name: string; baseUrl: string };

export const SUPPLY_CHAIN_PROVIDERS: SupplyChainProvider[] = [
  { name: "GitHub", baseUrl: "https://www.githubstatus.com" },
  { name: "Cloudflare", baseUrl: "https://www.cloudflarestatus.com" },
  { name: "CircleCI", baseUrl: "https://status.circleci.com" },
  { name: "npm", baseUrl: "https://status.npmjs.org" },
];

type ProviderIncident = {
  name: string;
};

export type ProviderStatus =
  | { name: string; kind: "ok" }
  | { name: string; kind: "incident"; incidents: ProviderIncident[] }
  | { name: string; kind: "error"; detail: string };

type HttpResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};

export type HttpFetch = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<HttpResponse>;

const FETCH_TIMEOUT_MS = 5_000;

const unresolvedSchema = z.object({
  incidents: z.array(z.object({ name: z.string() })),
});

const fetchProvider = async (
  provider: SupplyChainProvider,
  fetchFn: HttpFetch,
): Promise<ProviderStatus> => {
  try {
    const response = await fetchFn(
      `${provider.baseUrl}/api/v2/incidents/unresolved.json`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      return {
        name: provider.name,
        kind: "error",
        detail: `Status page returned ${response.status}`,
      };
    }
    const parsed = unresolvedSchema.safeParse(
      JSON.parse(await response.text()),
    );
    if (!parsed.success) {
      return {
        name: provider.name,
        kind: "error",
        detail: "Status page returned an unexpected payload",
      };
    }
    if (parsed.data.incidents.length === 0) {
      return { name: provider.name, kind: "ok" };
    }
    return {
      name: provider.name,
      kind: "incident",
      incidents: parsed.data.incidents,
    };
  } catch (error) {
    return {
      name: provider.name,
      kind: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
};

export const fetchProviderStatuses = async ({
  fetchFn = fetch,
  providers = SUPPLY_CHAIN_PROVIDERS,
}: {
  fetchFn?: HttpFetch;
  providers?: SupplyChainProvider[];
} = {}): Promise<ProviderStatus[]> =>
  Promise.all(providers.map((provider) => fetchProvider(provider, fetchFn)));
