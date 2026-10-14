import pc from "picocolors";
import { runPool } from "../pool.ts";
import type {
  Check,
  CheckContext,
  CheckResult,
  GlobalCheck,
  GlobalCheckResult,
  TickResults,
  Workspace,
} from "../types.ts";
import {
  type CellStatus,
  firstLine,
  glyph,
  shortLabel,
  spinner,
} from "./format.ts";
import type { Screen } from "./screen.ts";
import { type Row, renderGlobalChecks, renderWorkspaces } from "./table.ts";

type CellState = { status: CellStatus; text: string; detail: string };
type WorkspaceRow = {
  id: string;
  label: string;
  cells: Map<string, CellState>;
};
type GlobalRow = { name: string; cell: CellState };

export type Dashboard = {
  run: () => Promise<TickResults>;
  setFooter: (text: string) => void;
  render: () => void;
  finish: () => void;
};

const pendingCell = (nowMs: number): CellState => ({
  status: "pending",
  text: `${spinner(nowMs)} …`,
  detail: "",
});

export const createDashboard = ({
  checks,
  globalChecks = [],
  context,
  screen,
  now = () => Date.now(),
  concurrency = 4,
}: {
  checks: Check[];
  globalChecks?: GlobalCheck[];
  context: CheckContext;
  screen: Screen;
  now?: () => number;
  concurrency?: number;
}): Dashboard => {
  const columns = checks.map((check) => check.column);
  const rows = new Map<string, WorkspaceRow>();
  const globals = new Map<string, GlobalRow>();
  const notices = new Set<string>();
  let footer = "starting…";

  const frame = (): string[] => {
    const tableRows: Row[] = [...rows.values()].map((row) => {
      const cells = checks.map((check) => {
        const cell = row.cells.get(check.name);
        return cell === undefined
          ? undefined
          : { status: cell.status, text: cell.text };
      });
      const details = checks.flatMap((check, index) => {
        const cell = row.cells.get(check.name);
        if (
          cell === undefined ||
          (cell.status !== "action" && cell.status !== "error")
        ) {
          return [];
        }
        return [{ text: firstLine(cell.detail), column: index }];
      });
      return { label: row.label, cells, details };
    });

    const globalRows: Row[] = [...globals.values()].map((row) => ({
      label: row.name,
      cells: [{ status: row.cell.status, text: row.cell.text }],
      details:
        row.cell.status === "action" || row.cell.status === "error"
          ? row.cell.detail
              .split("\n")
              .filter((line) => line.trim().length > 0)
              .map((text) => ({ text, column: 0 }))
          : [],
    }));

    const noticeLines = [...notices].map((notice) => pc.yellow(`! ${notice}`));
    return [
      pc.bold(`paseo-watch · ${rows.size} workspaces`),
      "",
      ...renderWorkspaces({ columns, rows: tableRows, width: screen.columns }),
      ...(globalRows.length > 0
        ? [
            "",
            ...renderGlobalChecks({ rows: globalRows, width: screen.columns }),
          ]
        : []),
      ...(noticeLines.length > 0 ? ["", ...noticeLines] : []),
      "",
      pc.dim(footer),
    ];
  };

  const render = (): void => screen.update(frame());

  const run = async (): Promise<TickResults> => {
    rows.clear();
    globals.clear();
    const targetsByCheck: Array<{ check: Check; targets: Workspace[] }> = [];

    // Seed pending cells only for the checks that actually target each
    // workspace, so checks that do not apply stay blank rather than spinning.
    const nowMs = now();
    for (const check of checks) {
      const targets = await check.targets(context);
      targetsByCheck.push({ check, targets });
      for (const workspace of targets) {
        const row = rows.get(workspace.id) ?? {
          id: workspace.id,
          label: workspace.name,
          cells: new Map<string, CellState>(),
        };
        rows.set(workspace.id, row);
        row.cells.set(check.name, pendingCell(nowMs));
      }
    }
    for (const check of globalChecks) {
      globals.set(check.name, { name: check.name, cell: pendingCell(nowMs) });
    }
    render();

    const results: CheckResult[] = [];
    await Promise.all(
      targetsByCheck.map(({ check, targets }) =>
        runPool(targets, concurrency, async (workspace) => {
          const result = await check.run(workspace, context);
          results.push(result);
          rows.get(workspace.id)?.cells.set(check.name, {
            status: result.status,
            text: `${glyph(result.status)} ${shortLabel(result)}`,
            detail: result.detail,
          });
          render();
        }),
      ),
    );

    const globalResults = new Map<string, GlobalCheckResult>();
    await runPool(globalChecks, concurrency, async (check) => {
      const result = await check.run(context);
      globalResults.set(check.name, result);
      globals.set(check.name, {
        name: check.name,
        cell: {
          status: result.status,
          text: `${glyph(result.status)} ${shortLabel(result)}`,
          detail: result.detail,
        },
      });
      render();
    });

    for (const result of results) {
      if (result.notice) notices.add(result.notice);
    }
    render();
    return {
      workspaces: results,
      global: globalChecks.flatMap((check) => {
        const result = globalResults.get(check.name);
        return result === undefined ? [] : [result];
      }),
    };
  };

  return {
    run,
    setFooter: (text) => {
      footer = text;
    },
    render,
    finish: () => screen.final(frame()),
  };
};
