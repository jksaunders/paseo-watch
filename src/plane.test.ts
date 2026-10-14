import { describe, expect, it, vi } from "vitest";
import {
  fetchPlaneWorkItem,
  type HttpFetch,
  PLANE_WORKSPACE_SLUG,
  PROJECT_IDENTIFIER,
  parseWorkItemRef,
  prFooter,
} from "./plane.ts";

const json = (body: unknown) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
});

const httpError = (status: number, detail = "") => ({
  ok: false,
  status,
  text: async () => detail,
});

const pathOf = (url: string) => new URL(url).pathname;

const planeFetch = (opts: {
  stateName?: string;
  stateId?: string;
  links?: string[];
  project?: boolean;
  item?: boolean;
}): HttpFetch => {
  const fetchFn = async (url: string) => {
    const path = pathOf(url);
    if (path.endsWith("/links/")) {
      return json({ results: (opts.links ?? []).map((url) => ({ url })) });
    }
    if (path.includes("/work-items/")) {
      return json({
        results: opts.item === false ? [] : [{ id: "item1", state: "state1" }],
      });
    }
    if (path.endsWith("/states/")) {
      return json({
        results: [
          {
            id: opts.stateId ?? "state1",
            name: opts.stateName ?? "Needs Review",
          },
        ],
      });
    }
    return json({
      results:
        opts.project === false
          ? []
          : [{ id: "proj1", identifier: PROJECT_IDENTIFIER }],
    });
  };
  return fetchFn as HttpFetch;
};

describe("parseWorkItemRef", () => {
  it("reads the ref from a workspace name", () => {
    expect(parseWorkItemRef(`${PROJECT_IDENTIFIER}-127: Clear dice`)).toBe(
      `${PROJECT_IDENTIFIER}-127`,
    );
  });

  it("is case-insensitive", () => {
    expect(
      parseWorkItemRef(`${PROJECT_IDENTIFIER.toLowerCase()}-8: something`),
    ).toBe(`${PROJECT_IDENTIFIER}-8`);
  });

  it("returns null without a ref", () => {
    expect(parseWorkItemRef("main")).toBeNull();
  });
});

describe("prFooter", () => {
  it("matches the footer link-pr writes", () => {
    const ref = `${PROJECT_IDENTIFIER}-328`;
    expect(prFooter(ref)).toBe(
      `This PR implements [${ref}](https://app.plane.so/${PLANE_WORKSPACE_SLUG}/browse/${ref}/).`,
    );
  });
});

describe("fetchPlaneWorkItem", () => {
  it("reads the state name and links", async () => {
    const outcome = await fetchPlaneWorkItem({
      apiKey: "key",
      ref: `${PROJECT_IDENTIFIER}-1`,
      fetchFn: planeFetch({
        links: ["https://github.com/o/r/pull/1"],
      }),
    });

    expect(outcome).toEqual({
      kind: "ok",
      workItem: {
        stateName: "Needs Review",
        links: ["https://github.com/o/r/pull/1"],
      },
    });
  });

  it("sends the API key and filters by sequence id", async () => {
    const fetchFn = vi.fn(planeFetch({}));
    await fetchPlaneWorkItem({
      apiKey: "secret",
      ref: `${PROJECT_IDENTIFIER}-328`,
      fetchFn,
    });

    const [url, init] = fetchFn.mock.calls.find(([url]) =>
      url.includes("/work-items/"),
    ) as [string, { headers: Record<string, string> }];
    expect(new URL(url).searchParams.get("pql")).toBe("sequence_id = 328");
    expect(init.headers["X-API-Key"]).toBe("secret");
  });

  it("leaves the state name null when it is unknown", async () => {
    const outcome = await fetchPlaneWorkItem({
      apiKey: "key",
      ref: `${PROJECT_IDENTIFIER}-1`,
      fetchFn: planeFetch({ stateId: "other" }),
    });
    expect(outcome).toMatchObject({
      kind: "ok",
      workItem: { stateName: null },
    });
  });

  it("errors when the project is missing", async () => {
    const outcome = await fetchPlaneWorkItem({
      apiKey: "key",
      ref: `${PROJECT_IDENTIFIER}-1`,
      fetchFn: planeFetch({ project: false }),
    });
    expect(outcome).toEqual({
      kind: "error",
      detail: `No Plane project "${PROJECT_IDENTIFIER}".`,
    });
  });

  it("errors when the work item is missing", async () => {
    const outcome = await fetchPlaneWorkItem({
      apiKey: "key",
      ref: `${PROJECT_IDENTIFIER}-1`,
      fetchFn: planeFetch({ item: false }),
    });
    expect(outcome).toEqual({
      kind: "error",
      detail: `No Plane work item ${PROJECT_IDENTIFIER}-1.`,
    });
  });

  it("errors on a failed request", async () => {
    const outcome = await fetchPlaneWorkItem({
      apiKey: "key",
      ref: `${PROJECT_IDENTIFIER}-1`,
      fetchFn: (async () => httpError(401, "unauthorized")) as HttpFetch,
    });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.detail).toContain("Plane API 401");
    }
  });

  it("errors on unparseable output", async () => {
    const outcome = await fetchPlaneWorkItem({
      apiKey: "key",
      ref: `${PROJECT_IDENTIFIER}-1`,
      fetchFn: (async () => ({
        ok: true,
        status: 200,
        text: async () => "nope",
      })) as HttpFetch,
    });
    expect(outcome.kind).toBe("error");
  });
});
