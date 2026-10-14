import pc from "picocolors";
import { clampLine } from "./ansi.ts";
import { type CellStatus, colourise, glyph } from "./format.ts";

type Cell = { status: CellStatus; text: string };
type Detail = { text: string; column: number };
export type Row = {
  label: string;
  cells: Array<Cell | undefined>;
  /** One line per notable cell, each aligned under the column it describes. */
  details?: Detail[];
};

const INDENT = "  ";
const GAP = "  ";
const MAX_CELL_WIDTH = 14;
const MIN_LABEL_WIDTH = 6;
const WORKSPACE_HEADER = "WORKSPACE";
/**
 * Below this the workspace name and the check columns cannot share a line
 * without both becoming unreadable, so the dashboard compresses each workspace
 * to a name plus a glyph-per-check strip.
 */
const NARROW_LAYOUT_MAX = 60;
const GLYPH_LEGEND = [
  `${glyph("ok")} ok`,
  `${glyph("action")} action`,
  `${glyph("error")} failed`,
  `${glyph("skip")} skip`,
  `${glyph("pending")} pending`,
].join("  ");

export const truncate = (text: string, max: number): string => {
  if (max <= 0) return "";
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
};

const shrink = (widths: number[], amount: number): number[] => {
  const result = [...widths];
  let remaining = amount;
  while (remaining > 0) {
    let index = -1;
    let widest = -1;
    for (let i = 0; i < result.length; i += 1) {
      const value = result[i] ?? 0;
      if (value > widest) {
        widest = value;
        index = i;
      }
    }
    if (index === -1 || widest <= 0) break;
    result[index] = (result[index] ?? 0) - 1;
    remaining -= 1;
  }
  return result;
};

const fitWidths = ({
  width,
  naturalLabel,
  desiredCells,
}: {
  width: number;
  naturalLabel: number;
  desiredCells: number[];
}): { labelWidth: number; cellWidths: number[] } => {
  const gaps = GAP.length * desiredCells.length;
  const budget = Math.max(0, width - INDENT.length - gaps);
  const desiredTotal = desiredCells.reduce((total, cell) => total + cell, 0);

  const labelWidth = Math.min(
    naturalLabel,
    Math.max(MIN_LABEL_WIDTH, budget - desiredTotal),
    budget,
  );
  const cellsBudget = Math.max(0, budget - labelWidth);
  const cellWidths =
    desiredTotal <= cellsBudget
      ? desiredCells
      : shrink(desiredCells, desiredTotal - cellsBudget);

  return { labelWidth, cellWidths };
};

export const renderTable = ({
  columns,
  rows,
  width,
  labelHeader = WORKSPACE_HEADER,
  maxCellWidth = MAX_CELL_WIDTH,
}: {
  columns: string[];
  rows: Row[];
  width: number;
  labelHeader?: string;
  maxCellWidth?: number;
}): string[] => {
  const desiredCells = columns.map((column, index) =>
    Math.min(
      maxCellWidth,
      Math.max(
        column.length,
        ...rows.map((row) => row.cells[index]?.text.length ?? 0),
      ),
    ),
  );

  const naturalLabel = Math.max(
    labelHeader.length,
    ...rows.map((row) => row.label.length),
  );
  const { labelWidth, cellWidths } = fitWidths({
    width,
    naturalLabel,
    desiredCells,
  });

  const header =
    INDENT +
    pc.dim(truncate(labelHeader, labelWidth).padEnd(labelWidth)) +
    columns
      .map((column, index) => {
        const cellWidth = cellWidths[index] ?? 0;
        return GAP + pc.dim(truncate(column, cellWidth).padEnd(cellWidth));
      })
      .join("");

  const lines = [header];

  for (const row of rows) {
    const cells = columns
      .map((_, index) => {
        const cellWidth = cellWidths[index] ?? 0;
        const cell = row.cells[index] ?? {
          status: "pending" as const,
          text: "",
        };
        return (
          GAP +
          colourise(
            cell.status,
            truncate(cell.text, cellWidth).padEnd(cellWidth),
          )
        );
      })
      .join("");
    lines.push(
      INDENT + truncate(row.label, labelWidth).padEnd(labelWidth) + cells,
    );

    for (const detail of row.details ?? []) {
      const column = Math.min(
        Math.max(detail.column, 0),
        Math.max(columns.length - 1, 0),
      );
      const start = Math.min(
        INDENT.length +
          labelWidth +
          GAP.length * (column + 1) +
          cellWidths.slice(0, column).reduce((total, cell) => total + cell, 0),
        width,
      );
      lines.push(
        `${" ".repeat(start)}${pc.dim(
          truncate(detail.text, Math.max(0, width - start)),
        )}`,
      );
    }
  }

  return lines;
};

/**
 * Maps each glyph position in the strip back to its check, so the strip does
 * not read as a row of anonymous statuses.
 */
const columnKey = (columns: string[], width: number): string[] => {
  const entries = columns.map((column, index) => `${index + 1} ${column}`);
  const entryWidth =
    Math.max(0, ...entries.map((entry) => entry.length)) + GAP.length;
  const perRow = Math.max(
    1,
    Math.floor((width - INDENT.length) / Math.max(1, entryWidth)),
  );

  const lines: string[] = [];
  for (let start = 0; start < entries.length; start += perRow) {
    const row = entries.slice(start, start + perRow);
    lines.push(
      INDENT +
        pc.dim(
          row
            .map((entry) => entry.padEnd(entryWidth))
            .join("")
            .trimEnd(),
        ),
    );
  }
  return lines;
};

export const renderCompact = ({
  columns,
  rows,
  width,
}: {
  columns: string[];
  rows: Row[];
  width: number;
}): string[] => {
  const stripWidth = Math.max(0, columns.length * 2 - 1);
  const nameWidth = Math.max(
    1,
    width - INDENT.length - GAP.length - stripWidth,
  );

  const lines: string[] = [];
  for (const row of rows) {
    const strip = columns
      .map((_, index) => {
        const cell = row.cells[index];
        if (cell === undefined) return " ";
        return colourise(cell.status, glyph(cell.status));
      })
      .join(" ");
    lines.push(
      INDENT + truncate(row.label, nameWidth).padEnd(nameWidth) + GAP + strip,
    );

    for (const detail of row.details ?? []) {
      const cell = row.cells[detail.column];
      if (cell === undefined) continue;
      const text = detail.text.length > 0 ? detail.text : cell.text;
      lines.push(
        INDENT.repeat(2) +
          colourise(
            cell.status,
            truncate(
              `${columns[detail.column] ?? ""} ${text}`,
              width - INDENT.length * 2,
            ),
          ),
      );
    }
  }

  lines.push(
    "",
    ...columnKey(columns, width),
    pc.dim(truncate(GLYPH_LEGEND, width)),
  );
  return lines.map((line) => clampLine(line, width));
};

export const renderWorkspaces = ({
  columns,
  rows,
  width,
}: {
  columns: string[];
  rows: Row[];
  width: number;
}): string[] =>
  width < NARROW_LAYOUT_MAX
    ? renderCompact({ columns, rows, width })
    : renderTable({ columns, rows, width });

/**
 * The global-check table: one row per check, its title on the left and a single
 * status cell on the right. The status cell may use the full remaining width so
 * a provider list is not clipped the way a workspace check column is.
 */
export const renderGlobalChecks = ({
  rows,
  width,
}: {
  rows: Row[];
  width: number;
}): string[] =>
  renderTable({
    columns: ["STATUS"],
    rows,
    width,
    labelHeader: "CHECK",
    maxCellWidth: Number.POSITIVE_INFINITY,
  });
