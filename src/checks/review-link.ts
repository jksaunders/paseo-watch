import type { PullRequest } from "../github.ts";
import { fetchPlaneWorkItem, prFooter } from "../plane.ts";
import type { CheckContext } from "../types.ts";

const NEEDS_REVIEW_STATE = "Needs Review";

export type ReviewLinkOutcome =
  | { kind: "linked" }
  | { kind: "missing"; detail: string }
  | { kind: "no-key" }
  | { kind: "error"; detail: string };

/**
 * Whether a PR satisfies every `/needs-review` condition: the work item footer
 * in the body, the work item in `Needs Review`, and the PR linked on it.
 */
export const evaluateReviewLink = async ({
  ref,
  pull,
  context,
}: {
  ref: string;
  pull: PullRequest;
  context: CheckContext;
}): Promise<ReviewLinkOutcome> => {
  if (!pull.body.includes(prFooter(ref))) {
    return { kind: "missing", detail: `PR is missing the ${ref} link` };
  }

  if (context.config.planeApiKey === "") {
    return { kind: "no-key" };
  }

  const plane = await fetchPlaneWorkItem({
    apiKey: context.config.planeApiKey,
    ref,
  });
  if (plane.kind === "error") {
    return { kind: "error", detail: plane.detail };
  }

  const { stateName, links } = plane.workItem;
  if (stateName !== NEEDS_REVIEW_STATE) {
    return {
      kind: "missing",
      detail: `${ref} is "${stateName ?? "unknown"}", not "${NEEDS_REVIEW_STATE}"`,
    };
  }
  if (!links.includes(pull.url)) {
    return { kind: "missing", detail: `${ref} is missing the PR link` };
  }

  return { kind: "linked" };
};
