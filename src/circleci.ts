import type { Run } from "./types.ts";

const CIRCLE_CI_CONTEXT = /circleci/i;

export const isCircleciContext = (context: string): boolean =>
  CIRCLE_CI_CONTEXT.test(context);

export const fetchBranchFailureReport = async (
  run: Run,
  project: string,
  branch: string,
): Promise<string | null> => {
  const result = await run("circleci", [
    "run",
    "get",
    "--project",
    project,
    "--branch",
    branch,
    "--failure-report",
    "--no-interactive",
  ]);
  const report = result.stdout.trim();
  return result.code === 0 && report !== "" ? report : null;
};
