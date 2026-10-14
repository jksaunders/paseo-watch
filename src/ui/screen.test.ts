import { describe, expect, it } from "vitest";
import { createScreen } from "./screen.ts";

const fakeStream = (isTTY: boolean, columns = 80, rows?: number) => {
  const writes: string[] = [];
  const stream = {
    isTTY,
    columns,
    rows,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
  };
  return { stream: stream as unknown as NodeJS.WriteStream, writes };
};

describe("screen", () => {
  it("does nothing on update when not a TTY", () => {
    const { stream, writes } = fakeStream(false);
    const screen = createScreen(stream);
    screen.update(["a", "b"]);
    expect(writes).toEqual([]);
  });

  it("redraws in place, clearing the previous frame", () => {
    const { stream, writes } = fakeStream(true);
    const screen = createScreen(stream);
    screen.update(["one"]);
    screen.update(["two"]);
    expect(writes.join("")).toBe("one\n\x1b[1A\x1b[0Jtwo\n");
  });

  it("clamps a line to the terminal width", () => {
    const { stream, writes } = fakeStream(true, 5);
    const screen = createScreen(stream);
    screen.update(["abcdefghij"]);
    expect(writes.join("")).toBe("abcde\x1b[0m\n");
  });

  it("falls back to a default width when columns is zero", () => {
    const { stream, writes } = fakeStream(true, 0);
    const screen = createScreen(stream);
    screen.update(["a".repeat(200)]);
    expect(writes.join("")).toBe(`${"a".repeat(100)}\x1b[0m\n`);
  });

  it("clear erases the frame and reset forgets it", () => {
    const { stream, writes } = fakeStream(true);
    const screen = createScreen(stream);
    screen.update(["one"]);
    screen.clear();
    screen.reset();
    screen.update(["two"]);
    expect(writes.join("")).toBe("one\n\x1b[1A\x1b[0Jtwo\n");
  });

  it("redraws from a cleared screen when the frame fills the viewport", () => {
    const { stream, writes } = fakeStream(true, 80, 2);
    const screen = createScreen(stream);
    screen.update(["one", "two"]);
    screen.update(["three"]);
    expect(writes.join("")).toBe("one\ntwo\n\x1b[H\x1b[0Jthree\n");
  });

  it("keeps clearing the whole screen while the frame stays tall", () => {
    const { stream, writes } = fakeStream(true, 80, 2);
    const screen = createScreen(stream);
    screen.update(["one", "two"]);
    screen.update(["a", "b"]);
    expect(writes.join("")).toBe("one\ntwo\n\x1b[H\x1b[0Ja\nb\n");
  });

  it("clear erases a tall frame from a cleared screen and reset forgets it", () => {
    const { stream, writes } = fakeStream(true, 80, 2);
    const screen = createScreen(stream);
    screen.update(["one", "two"]);
    screen.clear();
    screen.reset();
    screen.update(["x"]);
    expect(writes.join("")).toBe("one\ntwo\n\x1b[H\x1b[0Jx\n");
  });

  it("prints the frame once when not a TTY", () => {
    const { stream, writes } = fakeStream(false);
    const screen = createScreen(stream);
    screen.final(["a", "b"]);
    expect(writes).toEqual(["a\nb\n"]);
  });
});
