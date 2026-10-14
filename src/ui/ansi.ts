const ESC = String.fromCharCode(27);
const RESET = "\x1b[0m";
const ANSI_PATTERN = new RegExp(`^${ESC}\\[[0-9;?]*[ -/]*[@-~]`);
const ZERO_WIDTH = /[\p{Mn}\p{Me}\p{Cf}]/u;
const WIDE =
  /[\u1100-\u115F\u2329\u232A\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]|\p{Extended_Pictographic}/u;

const charWidth = (char: string): number => {
  if (ZERO_WIDTH.test(char)) return 0;
  if (WIDE.test(char)) return 2;
  return 1;
};

export const clampLine = (line: string, columns: number): string => {
  if (columns <= 0) return "";
  let result = "";
  let visible = 0;
  let index = 0;
  while (index < line.length) {
    const match = line.slice(index).match(ANSI_PATTERN);
    if (match) {
      result += match[0];
      index += match[0].length;
      continue;
    }
    const char = String.fromCodePoint(line.codePointAt(index) ?? 0);
    const width = charWidth(char);
    if (visible + width > columns) return `${result}${RESET}`;
    result += char;
    visible += width;
    index += char.length;
  }
  return result;
};
