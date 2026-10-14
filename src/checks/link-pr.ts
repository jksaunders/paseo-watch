import type { Check, CheckResult, Workspace } from "../types.ts";
import { resolveWorkspacePull } from "./resolve-pull.ts";
import { result } from "./result.ts";
import { evaluateReviewLink } from "./review-link.ts";

const needsReview = (
  workspace: Workspace,
  headSha: string,
  detail: string,
  dryRun: boolean,
): CheckResult =>
  result(
    workspace,
    "action",
    dryRun ? `would send /needs-review — ${detail}` : detail,
    "needs link",
    { eventKey: `needs-review:${headSha}`, eventKind: "needs-review" },
  );

export const createPlanePrLinkCheck = (): Check => ({
  name: "planePrLink",
  column: "Plane/PR",
  targets: async (context) => context.workspaces,
  run: async (workspace, context) => {
    const resolved = await resolveWorkspacePull(workspace, context);
    if (resolved.kind === "result") return resolved.result;
    const { ref, headSha, pull } = resolved;

    const outcome = await evaluateReviewLink({ ref, pull, context });
    if (outcome.kind === "no-key") {
      return result(workspace, "skip", "PLANE_API_KEY is not set", "no key");
    }
    if (outcome.kind === "error") {
      return result(workspace, "error", outcome.detail, "error");
    }
    if (outcome.kind === "missing") {
      return needsReview(
        workspace,
        headSha,
        outcome.detail,
        context.config.dryRun,
      );
    }

    return result(workspace, "ok", `${ref} is linked and in review`, "linked");
  },
});
