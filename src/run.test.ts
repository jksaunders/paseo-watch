import { describe, expect, it, vi } from "vitest";
import { createLogger, createRun, silentLogger } from "./run.ts";

describe("createRun", () => {
  it("captures stdout and a zero exit", async () => {
    const result = await createRun()("node", [
      "-e",
      "process.stdout.write('hi')",
    ]);
    expect(result).toEqual({ stdout: "hi", stderr: "", code: 0 });
  });

  it("captures a non-zero exit code", async () => {
    const result = await createRun()("node", ["-e", "process.exit(3)"]);
    expect(result.code).toBe(3);
  });

  it("treats a missing command as 127", async () => {
    const result = await createRun()("definitely-not-a-command-xyz", []);
    expect(result.code).toBe(127);
  });

  it("kills a command that outlives the timeout", async () => {
    const result = await createRun({ timeoutMs: 50 })("node", [
      "-e",
      "setTimeout(() => {}, 5000)",
    ]);
    expect(result.code).toBe(124);
  });
});

describe("createLogger", () => {
  it("writes info to stdout and warnings to stderr", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const logger = createLogger(false);

    logger.info("hello");
    logger.warn("careful");
    logger.error("boom");

    expect(stdout).toHaveBeenCalledWith("hello\n");
    expect(stderr).toHaveBeenCalledWith("careful\n");
    expect(stderr).toHaveBeenCalledWith("boom\n");
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it("only writes debug output when verbose", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    createLogger(false).debug("quiet");
    expect(stderr).not.toHaveBeenCalled();

    createLogger(true).debug("loud");
    expect(stderr).toHaveBeenCalledWith("[debug] loud\n");
    stderr.mockRestore();
  });

  it("exposes a silent logger", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    silentLogger.info("x");
    silentLogger.warn("x");
    silentLogger.error("x");
    silentLogger.debug("x");
    expect(stdout).not.toHaveBeenCalled();
    stdout.mockRestore();
  });
});
