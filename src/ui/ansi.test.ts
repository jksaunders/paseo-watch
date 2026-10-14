import { describe, expect, it } from "vitest";
import { clampLine } from "./ansi.ts";

describe("clampLine", () => {
  it("keeps a line that fits unchanged", () => {
    expect(clampLine("\x1b[32mabc\x1b[39m", 6)).toBe("\x1b[32mabc\x1b[39m");
  });

  it("preserves escape sequences while clamping visible characters", () => {
    expect(clampLine("\x1b[32mabcdef\x1b[39m", 3)).toBe("\x1b[32mabc\x1b[0m");
  });

  it("appends a reset when it truncates a plain line", () => {
    expect(clampLine("abcdef", 3)).toBe("abc\x1b[0m");
  });

  it("returns empty when there is no room", () => {
    expect(clampLine("abc", 0)).toBe("");
  });

  it("counts a wide glyph as two columns", () => {
    expect(clampLine("你好吗", 4)).toBe("你好\x1b[0m");
  });

  it("does not split a surrogate pair", () => {
    expect(clampLine("a😀b", 2)).toBe("a\x1b[0m");
  });

  it("does not count combining marks as columns", () => {
    expect(clampLine("e\u0301e\u0301", 2)).toBe("e\u0301e\u0301");
  });
});
