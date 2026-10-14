import { describe, expect, it } from "vitest";
import { colourise, firstLine, glyph, shortLabel, spinner } from "./format.ts";

describe("format", () => {
  it("maps statuses to glyphs", () => {
    expect(glyph("ok")).toBe("✓");
    expect(glyph("action")).toBe("●");
    expect(glyph("skip")).toBe("–");
    expect(glyph("error")).toBe("✗");
  });

  it("animates the spinner over time", () => {
    expect(spinner(0)).not.toBe(spinner(100));
  });

  it("takes the first line of multi-line detail", () => {
    expect(firstLine("first\nsecond")).toBe("first");
  });

  it("prefers an explicit label over the detail", () => {
    expect(shortLabel({ detail: "d", label: "ok" })).toBe("ok");
    expect(shortLabel({ detail: "d\nmore" })).toBe("d");
  });

  it("colourises without changing the text", () => {
    expect(colourise("skip", "hello")).toContain("hello");
  });
});
