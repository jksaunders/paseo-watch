import { note } from "@clack/prompts";
import { markPrompted, unpromptedEvents, type WatchState } from "../state.ts";
import type { CheckResult, Logger } from "../types.ts";

export type StartAgent = (
  event: CheckResult,
) => Promise<{ ok: boolean; detail: string }>;

export const presentEvents = async ({
  results,
  state,
  dryRun,
  now,
  startAgent,
  logger,
}: {
  results: CheckResult[];
  state: WatchState;
  dryRun: boolean;
  now: () => Date;
  startAgent: StartAgent;
  logger: Logger;
}): Promise<void> => {
  for (const event of unpromptedEvents(results, state)) {
    if (!event.eventKey) continue;
    note(event.detail, event.target);

    // Only consume an event once it has been acted on. A dry run, or an event
    // with no workspace to act in, stays unprompted so a later run can handle it.
    if (dryRun || !event.workspaceId) continue;

    // A failed start leaves the event unprompted so it is retried next tick.
    const outcome = await startAgent(event);
    if (outcome.ok) {
      logger.info(outcome.detail);
      markPrompted(state, event.eventKey, now().toISOString());
    } else {
      logger.warn(`Could not start an agent: ${outcome.detail}`);
    }
  }
};
