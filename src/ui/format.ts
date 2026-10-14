import pc from "picocolors";
import type { CheckStatus } from "../types.ts";

export type CellStatus = CheckStatus | "pending";

const GLYPHS: Record<CheckStatus, string> = {
  ok: "✓",
  action: "●",
  skip: "–",
  error: "✗",
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const PENDING_GLYPH = SPINNER[0] ?? "⠋";

export const spinner = (nowMs: number): string =>
  SPINNER[Math.floor(nowMs / 100) % SPINNER.length] ?? PENDING_GLYPH;

export const glyph = (status: CellStatus): string =>
  status === "pending" ? PENDING_GLYPH : GLYPHS[status];

export const colourise = (status: CellStatus, text: string): string => {
  if (status === "ok") return pc.green(text);
  if (status === "action") return pc.yellow(text);
  if (status === "error") return pc.red(text);
  return pc.dim(text);
};

export const firstLine = (text: string): string => text.split("\n")[0] ?? text;

export const shortLabel = (result: {
  label?: string;
  detail: string;
}): string => result.label ?? firstLine(result.detail);
