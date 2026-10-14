import { describe, expect, it } from "vitest";
import { restartNotice, SELF_DIR, selfChanged } from "./self.ts";
import { fail, fakeRun, ok } from "./test-helpers.ts";

// This reference repo keeps the watcher at the repo root, so `SELF_DIR` is the
// repo root and changed paths are relative to it.
const repoRoot = SELF_DIR;

describe("selfChanged", () => {
  it("matches runtime source files", () => {
    expect(selfChanged(["src/x.ts"], repoRoot, SELF_DIR)).toBe(true);
    expect(selfChanged(["src/checks/pull.ts"], repoRoot, SELF_DIR)).toBe(true);
  });

  it("matches the package manifest", () => {
    expect(selfChanged(["package.json"], repoRoot, SELF_DIR)).toBe(true);
  });

  it("ignores test-only files", () => {
    expect(selfChanged(["src/x.test.ts"], repoRoot, SELF_DIR)).toBe(false);
    expect(selfChanged(["src/test-helpers.ts"], repoRoot, SELF_DIR)).toBe(
      false,
    );
  });

  it("ignores unrelated files", () => {
    expect(selfChanged(["apps/web/x.ts"], repoRoot, SELF_DIR)).toBe(false);
    expect(selfChanged(["tsconfig.json"], repoRoot, SELF_DIR)).toBe(false);
    expect(selfChanged([], repoRoot, SELF_DIR)).toBe(false);
  });

  it("ignores a package outside the repo", () => {
    expect(
      selfChanged(["packages/paseo-watch/x.ts"], "/elsewhere", "/outside/pkg"),
    ).toBe(false);
  });

  it("still matches when embedded under a monorepo package path", () => {
    expect(
      selfChanged(
        ["packages/paseo-watch/src/x.ts"],
        "/repo",
        "/repo/packages/paseo-watch",
      ),
    ).toBe(true);
    expect(
      selfChanged(
        ["packages/paseo-watch/tsconfig.json"],
        "/repo",
        "/repo/packages/paseo-watch",
      ),
    ).toBe(false);
  });
});

describe("restartNotice", () => {
  it("returns undefined without changed files", async () => {
    expect(
      await restartNotice(
        fakeRun(() => ok()),
        "/repo",
        null,
      ),
    ).toBeUndefined();
  });

  it("notes when the watcher's own code changed", async () => {
    const run = fakeRun((_command, args) =>
      args.includes("--show-toplevel") ? ok(`${repoRoot}\n`) : undefined,
    );

    expect(await restartNotice(run, "/repo", ["src/a.ts"])).toBe(
      "restart to pick up new watcher code",
    );
  });

  it("stays quiet for unrelated changes", async () => {
    const run = fakeRun((_command, args) =>
      args.includes("--show-toplevel") ? ok(`${repoRoot}\n`) : undefined,
    );
    expect(
      await restartNotice(run, "/repo", ["apps/web/a.ts"]),
    ).toBeUndefined();
  });

  it("stays quiet when git fails", async () => {
    expect(
      await restartNotice(
        fakeRun(() => fail(1)),
        "/repo",
        ["x"],
      ),
    ).toBeUndefined();
  });
});
