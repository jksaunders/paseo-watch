import process from "node:process";
import { clampLine } from "./ansi.ts";

const DEFAULT_COLUMNS = 100;

export type Screen = {
  isTTY: boolean;
  columns: number;
  update: (lines: string[]) => void;
  clear: () => void;
  reset: () => void;
  final: (lines: string[]) => void;
};

export const createScreen = (
  stream: NodeJS.WriteStream = process.stdout,
): Screen => {
  const isTTY = Boolean(stream.isTTY);
  let previous = 0;
  let full = false;

  const columns = (): number => {
    const value = stream.columns;
    return typeof value === "number" && value > 0 ? value : DEFAULT_COLUMNS;
  };

  const rows = (): number | undefined => {
    const value = stream.rows;
    return typeof value === "number" && value > 0 ? value : undefined;
  };

  const update = (lines: string[]): void => {
    if (!isTTY) return;
    const width = columns();
    const frame = lines.map((line) => clampLine(line, width));
    const viewport = rows();
    // A frame that fills the viewport scrolls the terminal, so its first line
    // is no longer one cursor-up away; redraw from a cleared screen instead.
    const tooTall = viewport !== undefined && frame.length >= viewport;
    if (previous > 0 && (full || tooTall)) {
      stream.write("\x1b[H\x1b[0J");
    } else if (previous > 0) {
      stream.write(`\x1b[${previous}A\x1b[0J`);
    }
    stream.write(`${frame.join("\n")}\n`);
    previous = frame.length;
    full = tooTall;
  };

  const clear = (): void => {
    if (!isTTY) return;
    if (previous > 0) {
      stream.write(full ? "\x1b[H\x1b[0J" : `\x1b[${previous}A\x1b[0J`);
    }
    previous = 0;
    full = false;
  };

  return {
    isTTY,
    get columns() {
      return columns();
    },
    update,
    clear,
    reset: () => {
      previous = 0;
      full = false;
    },
    final: (lines) => {
      if (isTTY) update(lines);
      else stream.write(`${lines.join("\n")}\n`);
    },
  };
};
