import { SUPPLY_CHAIN_INCIDENT_LABEL, setWorkspaceLabel } from "../labels.ts";
import { fetchProviderStatuses, type ProviderStatus } from "../status-pages.ts";
import type { CheckContext, CheckStatus, GlobalCheck } from "../types.ts";
import { findMainWorkspace } from "../workspaces.ts";

const NAME = "Supply chain";

type IncidentStatus = Extract<ProviderStatus, { kind: "incident" }>;
type ErrorStatus = Extract<ProviderStatus, { kind: "error" }>;

const providerNames = (statuses: ProviderStatus[]): string =>
  statuses.map((status) => status.name).join(", ");

const incidentLines = (statuses: IncidentStatus[]): string[] =>
  statuses.flatMap((status) =>
    status.incidents.map((incident) => `${status.name}: ${incident.name}`),
  );

/**
 * The label lives on the project's main workspace, so a confident signal is
 * needed before touching it. Returns a line to append to the row detail.
 */
const reconcileLabel = async (
  context: CheckContext,
  incident: boolean,
): Promise<string | null> => {
  const main = findMainWorkspace(context.workspaces);
  if (!main) return "no main workspace to label";

  const has = main.labels.includes(SUPPLY_CHAIN_INCIDENT_LABEL);
  if (has === incident) return null;

  if (context.config.dryRun) {
    return incident ? "would add the label" : "would remove the label";
  }

  const outcome = await setWorkspaceLabel(
    context.config,
    main.id,
    SUPPLY_CHAIN_INCIDENT_LABEL,
    incident,
  );
  if (!outcome.ok) return `label update failed: ${outcome.detail}`;

  main.labels = incident
    ? [...main.labels, SUPPLY_CHAIN_INCIDENT_LABEL]
    : main.labels.filter((label) => label !== SUPPLY_CHAIN_INCIDENT_LABEL);
  return incident ? "label added" : "label removed";
};

export const createSupplyChainCheck = (): GlobalCheck => ({
  name: NAME,
  run: async (context) => {
    const statuses = await fetchProviderStatuses();
    const incidents = statuses.filter(
      (status): status is IncidentStatus => status.kind === "incident",
    );
    const errors = statuses.filter(
      (status): status is ErrorStatus => status.kind === "error",
    );
    const hasIncident = incidents.length > 0;

    // A status page that cannot be reached is not evidence that everything is
    // fine, so the label is left alone unless the outcome is known.
    const confident = hasIncident || errors.length === 0;
    const labelNote = confident
      ? await reconcileLabel(context, hasIncident)
      : null;

    let lines: string[];
    let status: CheckStatus = "ok";
    let label = "Operational";

    if (hasIncident) {
      lines = incidentLines(incidents);
      if (errors.length > 0) {
        lines.push(`Unreachable: ${providerNames(errors)}`);
      }
      status = "error";
      label = providerNames(incidents);
    } else if (errors.length > 0) {
      lines = errors.map((error) => `${error.name}: ${error.detail}`);
      status = "error";
      label = "Unreachable";
    } else {
      lines = [`All ${statuses.length} providers operational`];
    }

    if (labelNote) lines.push(labelNote);
    return { status, label, detail: lines.join("\n") };
  },
});
