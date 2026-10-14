import type { CheckResult, ResultExtras, Workspace } from "../types.ts";

export const result = (
  workspace: Workspace,
  status: CheckResult["status"],
  detail: string,
  label: string,
  extras: ResultExtras = {},
): CheckResult => ({
  target: workspace.name,
  workspaceId: workspace.id,
  status,
  detail,
  label,
  ...(extras.eventKey === undefined ? {} : { eventKey: extras.eventKey }),
  ...(extras.eventKind === undefined ? {} : { eventKind: extras.eventKind }),
  ...(extras.notice === undefined ? {} : { notice: extras.notice }),
});
