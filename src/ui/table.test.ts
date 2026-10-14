import { stripVTControlCharacters as strip } from "node:util";
import { describe, expect, it } from "vitest";
import {
  renderCompact,
  renderGlobalChecks,
  renderTable,
  renderWorkspaces,
  truncate,
} from "./table.ts";

describe("truncate", () => {
  it("returns short text unchanged", () => {
    expect(truncate("abc", 3)).toBe("abc");
  });

  it("adds an ellipsis when too long", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
  });

  it("returns empty when there is no room", () => {
    expect(truncate("abc", 0)).toBe("");
  });
});

describe("renderTable", () => {
  it("aligns a column header and rows", () => {
    const lines = renderTable({
      columns: ["push", "ci"],
      rows: [
        {
          label: "TASK-1",
          cells: [
            { status: "ok", text: "✓ ok" },
            { status: "skip", text: "– main" },
          ],
        },
      ],
      width: 80,
    });

    expect(lines[0]).toContain("WORKSPACE");
    expect(lines[0]).toContain("push");
    expect(lines[1]).toContain("TASK-1");
    expect(lines[1]).toContain("✓ ok");
    expect(lines[1]).toContain("– main");
  });

  it("adds a detail line under a row when given one", () => {
    const lines = renderTable({
      columns: ["ci"],
      rows: [
        {
          label: "TASK-1",
          cells: [{ status: "action", text: "● failed" }],
          details: [{ text: "build_and_deploy failed", column: 0 }],
        },
      ],
      width: 80,
    });

    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("build_and_deploy failed");
  });

  it("aligns a detail line under the column it describes", () => {
    const lines = renderTable({
      columns: ["pull", "push"],
      rows: [
        {
          label: "A",
          cells: [
            { status: "skip", text: "– n/a" },
            { status: "action", text: "● pushed" },
          ],
          details: [{ text: "pushed 5 commits", column: 1 }],
        },
      ],
      width: 80,
    }).map(strip);

    const pushStart = lines[0]?.indexOf("push") ?? -1;
    const detailStart = lines[2]?.search(/\S/) ?? -1;
    expect(pushStart).toBeGreaterThan(0);
    expect(detailStart).toBe(pushStart);
    expect(lines[2]).toContain("pushed 5 commits");
  });

  it("stacks one detail line per notable column, each aligned under it", () => {
    const lines = renderTable({
      columns: ["pull", "push", "status"],
      rows: [
        {
          label: "A",
          cells: [
            { status: "skip", text: "– n/a" },
            { status: "action", text: "● pushed" },
            { status: "error", text: "✗ failed" },
          ],
          details: [
            { text: "pushed 5 commits", column: 1 },
            { text: "step 3 failed", column: 2 },
          ],
        },
      ],
      width: 90,
    }).map(strip);

    const pushStart = lines[0]?.indexOf("push") ?? -1;
    const statusStart = lines[0]?.indexOf("status") ?? -1;
    expect(lines[2]?.search(/\S/)).toBe(pushStart);
    expect(lines[2]).toContain("pushed 5 commits");
    expect(lines[3]?.search(/\S/)).toBe(statusStart);
    expect(lines[3]).toContain("step 3 failed");
  });

  it("leaves a check blank when it has no cell", () => {
    const lines = renderTable({
      columns: ["push"],
      rows: [{ label: "TASK-1", cells: [] }],
      width: 80,
    });
    expect(lines[1]).not.toContain("…");
    expect(lines[1]).not.toContain("✓");
  });

  it("truncates long workspace labels", () => {
    const lines = renderTable({
      columns: ["push"],
      rows: [
        {
          label: "x".repeat(200),
          cells: [{ status: "ok", text: "✓ ok" }],
        },
      ],
      width: 40,
    });
    expect(lines[1]).toContain("…");
  });

  it.each([12, 40, 50])(
    "keeps every line within a narrow width of %i",
    (width) => {
      const lines = renderTable({
        columns: ["pull", "push", "status", "quality"],
        rows: [
          {
            label: "task-330-paseo-watch-narrow-redraw",
            cells: [
              { status: "action", text: "● needs review" },
              { status: "ok", text: "✓ pushed" },
              { status: "error", text: "✗ failed" },
              { status: "skip", text: "– n/a" },
            ],
            details: [
              { text: "build_and_deploy failed on this branch", column: 2 },
            ],
          },
        ],
        width,
      });

      for (const line of lines) {
        expect(strip(line).length).toBeLessThanOrEqual(width);
      }
    },
  );

  it("keeps columns aligned when labels differ in length", () => {
    const lines = renderTable({
      columns: ["push", "ci"],
      rows: [
        {
          label: "short",
          cells: [
            { status: "ok", text: "✓ ok" },
            { status: "skip", text: "– main" },
          ],
        },
        {
          label: "y".repeat(200),
          cells: [
            { status: "ok", text: "✓ ok" },
            { status: "skip", text: "– main" },
          ],
        },
      ],
      width: 60,
    }).map(strip);

    const starts = [
      lines[0]?.indexOf("push"),
      lines[1]?.indexOf("✓"),
      lines[2]?.indexOf("✓"),
    ];
    expect(new Set(starts).size).toBe(1);
  });
});

describe("renderCompact", () => {
  it("keeps the name and one glyph per check on a single line", () => {
    const lines = renderCompact({
      columns: ["pull", "push", "status"],
      rows: [
        {
          label: "TASK-1",
          cells: [
            { status: "ok", text: "✓ clean" },
            { status: "skip", text: "– main" },
            { status: "action", text: "● failed" },
          ],
        },
      ],
      width: 40,
    }).map(strip);

    const line = lines[0] ?? "";
    expect(line).toContain("TASK-1");
    expect(line.indexOf("✓")).toBeLessThan(line.indexOf("●"));
    expect(line).not.toContain("clean");
    expect(line).not.toContain("failed");
  });

  it("names the check and shows its detail for a problem", () => {
    const lines = renderCompact({
      columns: ["pull", "push"],
      rows: [
        {
          label: "TASK-1",
          cells: [
            { status: "ok", text: "✓ clean" },
            { status: "action", text: "● pushed" },
          ],
          details: [{ text: "pushed 5 commits", column: 1 }],
        },
      ],
      width: 40,
    }).map(strip);

    expect(lines[1]).toContain("push pushed 5 commits");
    expect(lines.join("\n")).not.toContain("pull clean");
  });

  it("shows a pending check as a spinner glyph", () => {
    const lines = renderCompact({
      columns: ["pull"],
      rows: [{ label: "A", cells: [{ status: "pending", text: "⠋ …" }] }],
      width: 40,
    }).map(strip);

    expect(lines[0]).toContain("⠋");
  });

  it("omits a glyph for a check that does not apply", () => {
    const lines = renderCompact({
      columns: ["pull", "quality"],
      rows: [{ label: "A", cells: [{ status: "skip", text: "– n/a" }] }],
      width: 40,
    }).map(strip);

    expect(lines[0]).toContain("A");
    expect(lines[0]).not.toContain("quality");
    expect(lines.join("\n")).toContain("2 quality");
  });

  it("maps each glyph position back to its check", () => {
    const lines = renderCompact({
      columns: ["pull", "push", "Plane/PR"],
      rows: [
        {
          label: "A",
          cells: [
            { status: "ok", text: "✓ clean" },
            { status: "skip", text: "– main" },
            { status: "error", text: "✗ failed" },
          ],
        },
      ],
      width: 40,
    }).map(strip);

    const key = lines.join("\n");
    expect(key).toContain("1 pull");
    expect(key).toContain("2 push");
    expect(key).toContain("3 Plane/PR");
  });

  it("ends with a glyph legend", () => {
    const lines = renderCompact({
      columns: ["pull"],
      rows: [{ label: "A", cells: [{ status: "ok", text: "✓ ok" }] }],
      width: 40,
    }).map(strip);

    expect(lines.at(-1)).toContain("✓ ok");
  });

  it.each([12, 40, 50])(
    "keeps every line within a narrow width of %i",
    (width) => {
      const lines = renderCompact({
        columns: ["pull", "push", "status", "Plane/PR", "merge", "quality"],
        rows: [
          {
            label: "task-334-improve-paseo-watch-mobile-ux",
            cells: [
              { status: "action", text: "● needs review" },
              { status: "ok", text: "✓ pushed" },
              { status: "error", text: "✗ failed" },
              { status: "skip", text: "– n/a" },
              { status: "skip", text: "– no label" },
              { status: "skip", text: "– n/a" },
            ],
            details: [
              { text: "build_and_deploy failed on this branch", column: 2 },
            ],
          },
        ],
        width,
      }).map(strip);

      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(width);
      }
    },
  );
});

describe("renderWorkspaces", () => {
  const row = {
    label: "TASK-1",
    cells: [{ status: "ok" as const, text: "✓ ok" }],
  };

  it("uses the table layout on a wide screen", () => {
    const lines = renderWorkspaces({
      columns: ["push"],
      rows: [row],
      width: 80,
    }).map(strip);
    expect(lines[0]).toContain("WORKSPACE");
  });

  it("uses the compact layout on a narrow screen", () => {
    const lines = renderWorkspaces({
      columns: ["push"],
      rows: [row],
      width: 40,
    }).map(strip);
    expect(lines[0]).not.toContain("WORKSPACE");
    expect(lines[0]).toContain("TASK-1");
  });
});

describe("renderGlobalChecks", () => {
  it("renders one row per check with a CHECK header and a single status cell", () => {
    const lines = renderGlobalChecks({
      rows: [
        {
          label: "Supply chain",
          cells: [{ status: "error", text: "✗ Cloudflare, CircleCI" }],
        },
      ],
      width: 80,
    }).map(strip);

    expect(lines[0]).toContain("CHECK");
    expect(lines[0]).toContain("STATUS");
    expect(lines[1]).toContain("Supply chain");
    // The status cell is not clipped the way a workspace check column is.
    expect(lines[1]).toContain("Cloudflare, CircleCI");
    expect(lines[1]).not.toContain("…");
  });
});
