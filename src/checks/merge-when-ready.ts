import { MERGE_WHEN_READY_LABEL } from "../labels.ts";
import { isCommitPassed } from "../state.ts";
import type { Check } from "../types.ts";
import { resolveWorkspacePull } from "./resolve-pull.ts";
import { result } from "./result.ts";
import { evaluateReviewLink } from "./review-link.ts";

export const createMergeWhenReadyCheck = (): Check => ({
  name: "mergeWhenReady",
  column: "merge",
  targets: async (context) => context.workspaces,
  run: async (workspace, context) => {
    if (!workspace.labels.includes(MERGE_WHEN_READY_LABEL)) {
      return result(
        workspace,
        "skip",
        `${MERGE_WHEN_READY_LABEL} label missing`,
        "no label",
      );
    }

    const resolved = await resolveWorkspacePull(workspace, context);
    if (resolved.kind === "result") return resolved.result;
    const { ref, headSha, pull } = resolved;

    if (!isCommitPassed(context.state, headSha, pull.number)) {
      return result(workspace, "skip", "checks have not passed", "checks");
    }

    const review = await evaluateReviewLink({ ref, pull, context });
    if (review.kind === "no-key") {
      return result(workspace, "skip", "PLANE_API_KEY is not set", "no key");
    }
    if (review.kind === "error") {
      return result(workspace, "error", review.detail, "error");
    }
    if (review.kind === "missing") {
      return result(workspace, "skip", review.detail, "not in review");
    }

    return result(
      workspace,
      "action",
      context.config.dryRun ? "would send /done" : `${ref} is green`,
      "done",
      {
        eventKey: `merge-when-ready:${headSha}`,
        eventKind: "merge-when-ready",
      },
    );
  },
});
