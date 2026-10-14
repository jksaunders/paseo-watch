import { z } from "zod";

const API_BASE = "https://api.plane.so/api/v1";
export const PLANE_WORKSPACE_SLUG = "<plane workplace slug here>";
export const PROJECT_IDENTIFIER = "<project identifier here>";
const WORK_ITEM_REF = new RegExp(`${PROJECT_IDENTIFIER}-(\\d+)`, "i");

const projectListSchema = z.object({
  results: z.array(z.object({ id: z.string(), identifier: z.string() })),
});

const workItemListSchema = z.object({
  results: z.array(z.object({ id: z.string(), state: z.string().nullable() })),
});

const stateListSchema = z.object({
  results: z.array(z.object({ id: z.string(), name: z.string() })),
});

const linkListSchema = z.object({
  results: z.array(z.object({ url: z.string() })),
});

type HttpResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};

export type HttpFetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<HttpResponse>;

type PlaneWorkItem = {
  stateName: string | null;
  links: string[];
};

export type PlaneOutcome =
  | { kind: "ok"; workItem: PlaneWorkItem }
  | { kind: "error"; detail: string };

/** The `<identifier>-<n>` ref a workspace name carries, e.g. "ABC-127: Clear dice". */
export const parseWorkItemRef = (name: string): string | null => {
  const match = WORK_ITEM_REF.exec(name);
  return match ? `${PROJECT_IDENTIFIER}-${match[1]}` : null;
};

/** The footer `link-pr` writes, which is how the PR carries the work item ref. */
export const prFooter = (ref: string): string =>
  `This PR implements [${ref}](https://app.plane.so/${PLANE_WORKSPACE_SLUG}/browse/${ref}/).`;

const request = async (
  fetchFn: HttpFetch,
  apiKey: string,
  path: string,
  searchParams: Record<string, string>,
): Promise<unknown> => {
  const url = new URL(`${API_BASE}/workspaces/${PLANE_WORKSPACE_SLUG}${path}`);
  url.search = new URLSearchParams(searchParams).toString();

  const response = await fetchFn(url.toString(), {
    headers: { "X-API-Key": apiKey },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Plane API ${response.status} for ${url.pathname}: ${detail}`,
    );
  }
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
};

export const fetchPlaneWorkItem = async ({
  apiKey,
  ref,
  fetchFn = fetch,
}: {
  apiKey: string;
  ref: string;
  fetchFn?: HttpFetch;
}): Promise<PlaneOutcome> => {
  try {
    const projects = projectListSchema.parse(
      await request(fetchFn, apiKey, "/projects/", {
        per_page: "100",
      }),
    );
    const project = projects.results.find(
      (candidate) => candidate.identifier === PROJECT_IDENTIFIER,
    );
    if (!project) {
      throw new Error(`No Plane project "${PROJECT_IDENTIFIER}".`);
    }

    const sequenceId = Number(WORK_ITEM_REF.exec(ref)?.[1]);
    const items = workItemListSchema.parse(
      await request(fetchFn, apiKey, `/projects/${project.id}/work-items/`, {
        per_page: "100",
        pql: `sequence_id = ${sequenceId}`,
      }),
    );
    const item = items.results[0];
    if (!item) {
      throw new Error(`No Plane work item ${ref}.`);
    }

    const [states, links] = await Promise.all([
      request(fetchFn, apiKey, `/projects/${project.id}/states/`, {
        per_page: "100",
      }),
      request(
        fetchFn,
        apiKey,
        `/projects/${project.id}/work-items/${item.id}/links/`,
        { per_page: "100" },
      ),
    ]);

    return {
      kind: "ok",
      workItem: {
        stateName:
          stateListSchema
            .parse(states)
            .results.find((state) => state.id === item.state)?.name ?? null,
        links: linkListSchema.parse(links).results.map((link) => link.url),
      },
    };
  } catch (error) {
    return {
      kind: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
};
