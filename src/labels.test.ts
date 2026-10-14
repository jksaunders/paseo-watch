import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  daemonEndpoint,
  daemonLabelTransport,
  labelDefinition,
  READY_LABEL,
  removeWorkspaceLabel,
  SUPPLY_CHAIN_INCIDENT_LABEL,
  setWorkspaceLabel,
} from "./labels.ts";
import { testConfig } from "./test-helpers.ts";

describe("removeWorkspaceLabel", () => {
  let home: string;
  let statePath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(os.tmpdir(), "paseo-labels-"));
    statePath = join(home, "projects", "workspaces.json");
    await mkdir(join(home, "projects"), { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const config = () => testConfig({ paseoHome: home });

  const writeEntries = (entries: unknown[]) =>
    writeFile(statePath, JSON.stringify(entries, null, 2));

  const readEntries = async () =>
    JSON.parse(await readFile(statePath, "utf8")) as Array<{
      labels?: string[];
      branch?: string;
    }>;

  it("removes the label and keeps every other field", async () => {
    await writeEntries([
      {
        workspaceId: "w1",
        labels: [READY_LABEL, "keep-me"],
        branch: "task-1/x",
      },
    ]);

    const outcome = await removeWorkspaceLabel(config(), "w1", READY_LABEL);

    expect(outcome.ok).toBe(true);
    const saved = await readEntries();
    expect(saved[0]?.labels).toEqual(["keep-me"]);
    expect(saved[0]?.branch).toBe("task-1/x");
  });

  it("adds a label and keeps every other field", async () => {
    await writeEntries([
      { workspaceId: "w1", labels: ["keep-me"], branch: "task-1/x" },
    ]);

    const outcome = await setWorkspaceLabel(
      config(),
      "w1",
      SUPPLY_CHAIN_INCIDENT_LABEL,
      true,
    );

    expect(outcome.ok).toBe(true);
    const saved = await readEntries();
    expect(saved[0]?.labels).toEqual(["keep-me", SUPPLY_CHAIN_INCIDENT_LABEL]);
    expect(saved[0]?.branch).toBe("task-1/x");
  });

  it("succeeds without writing when the label is already present", async () => {
    await writeEntries([
      { workspaceId: "w1", labels: [SUPPLY_CHAIN_INCIDENT_LABEL] },
    ]);

    const outcome = await setWorkspaceLabel(
      config(),
      "w1",
      SUPPLY_CHAIN_INCIDENT_LABEL,
      true,
    );

    expect(outcome.ok).toBe(true);
    expect((await readEntries())[0]?.labels).toEqual([
      SUPPLY_CHAIN_INCIDENT_LABEL,
    ]);
  });

  it("leaves no temp file behind", async () => {
    await writeEntries([{ workspaceId: "w1", labels: [READY_LABEL] }]);

    await removeWorkspaceLabel(config(), "w1", READY_LABEL);

    expect(await readdir(join(home, "projects"))).toEqual(["workspaces.json"]);
  });

  it("succeeds without writing when the label is already absent", async () => {
    await writeEntries([{ workspaceId: "w1", labels: ["other"] }]);

    const outcome = await removeWorkspaceLabel(config(), "w1", READY_LABEL);

    expect(outcome.ok).toBe(true);
    expect((await readEntries())[0]?.labels).toEqual(["other"]);
  });

  it("fails when the workspace is not present", async () => {
    await writeEntries([{ workspaceId: "other", labels: [READY_LABEL] }]);

    const outcome = await removeWorkspaceLabel(config(), "w1", READY_LABEL);

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("w1");
  });

  it("fails when the state file is missing", async () => {
    const outcome = await removeWorkspaceLabel(config(), "w1", READY_LABEL);
    expect(outcome.ok).toBe(false);
  });

  it("fails when the state file is not an array", async () => {
    await writeFile(statePath, JSON.stringify({ labels: [] }));
    const outcome = await removeWorkspaceLabel(config(), "w1", READY_LABEL);
    expect(outcome.ok).toBe(false);
  });
});

describe("removeWorkspaceLabel via the Paseo daemon", () => {
  let home: string;
  let statePath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(os.tmpdir(), "paseo-labels-"));
    statePath = join(home, "projects", "workspaces.json");
    await mkdir(join(home, "projects"), { recursive: true });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await rm(home, { recursive: true, force: true });
  });

  const config = () => testConfig({ paseoHome: home });

  const writeDaemonFiles = async () => {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ daemon: { listen: "127.0.0.1:9999" } }),
    );
    await writeFile(
      join(home, "projects", "workspace-labels.json"),
      JSON.stringify([{ name: READY_LABEL, color: "emerald" }]),
    );
  };

  it("reads the daemon endpoint from config.json", async () => {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ daemon: { listen: "127.0.0.1:9999" } }),
    );
    expect(await daemonEndpoint(home)).toBe("127.0.0.1:9999");
  });

  it("returns no endpoint when config.json is missing or malformed", async () => {
    expect(await daemonEndpoint(home)).toBeNull();
    await writeFile(join(home, "config.json"), "not json");
    expect(await daemonEndpoint(home)).toBeNull();
  });

  it("prefers the live endpoint published in paseo.pid", async () => {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ daemon: { listen: "127.0.0.1:9999" } }),
    );
    await writeFile(
      join(home, "paseo.pid"),
      JSON.stringify({ listen: "127.0.0.1:8123" }),
    );
    expect(await daemonEndpoint(home)).toBe("127.0.0.1:8123");
  });

  it("normalizes a wildcard host to loopback", async () => {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ daemon: { listen: "0.0.0.0:6767" } }),
    );
    expect(await daemonEndpoint(home)).toBe("127.0.0.1:6767");
  });

  it("returns no endpoint for a unix socket path", async () => {
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ daemon: { listen: "/tmp/paseo.sock" } }),
    );
    expect(await daemonEndpoint(home)).toBeNull();
  });

  it("reads a label definition from the catalog", async () => {
    await writeFile(
      join(home, "projects", "workspace-labels.json"),
      JSON.stringify([{ name: READY_LABEL, color: "emerald" }]),
    );
    expect(await labelDefinition(home, READY_LABEL)).toEqual({
      name: READY_LABEL,
      color: "emerald",
    });
  });

  it("returns no definition when the catalog is missing or lacks the label", async () => {
    expect(await labelDefinition(home, READY_LABEL)).toBeNull();
    await writeFile(
      join(home, "projects", "workspace-labels.json"),
      JSON.stringify([{ name: "other", color: "sky" }]),
    );
    expect(await labelDefinition(home, READY_LABEL)).toBeNull();
  });

  it("removes through the daemon without touching the state file", async () => {
    await writeDaemonFiles();
    const transport = vi.fn(async () => ({ kind: "ok" as const }));

    const outcome = await removeWorkspaceLabel(
      config(),
      "w1",
      READY_LABEL,
      transport,
    );

    expect(outcome.ok).toBe(true);
    expect(transport).toHaveBeenCalledWith(
      "127.0.0.1:9999",
      "w1",
      { name: READY_LABEL, color: "emerald" },
      false,
    );
  });

  it("reports a rejection without editing the state file", async () => {
    await writeDaemonFiles();
    const transport = vi.fn(async () => ({
      kind: "rejected" as const,
      detail: "nope",
    }));
    const outcome = await removeWorkspaceLabel(
      config(),
      "w1",
      READY_LABEL,
      transport,
    );
    expect(outcome).toEqual({ ok: false, detail: "nope" });
  });

  it("falls back to the state file when the daemon is unreachable", async () => {
    await writeDaemonFiles();
    await writeFile(
      statePath,
      JSON.stringify([{ workspaceId: "w1", labels: [READY_LABEL] }]),
    );
    const transport = vi.fn(async () => ({
      kind: "unreachable" as const,
      detail: "down",
    }));

    const outcome = await removeWorkspaceLabel(
      config(),
      "w1",
      READY_LABEL,
      transport,
    );

    expect(outcome.ok).toBe(true);
    const saved = JSON.parse(await readFile(statePath, "utf8")) as Array<{
      labels?: string[];
    }>;
    expect(saved[0]?.labels).toEqual([]);
  });
});

type Listener = (event: { data?: unknown }) => void;

class FakeSocket {
  static instances: FakeSocket[] = [];
  readonly url: string;
  readonly sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  emitMessage(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }
}

describe("daemonLabelTransport", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const start = () =>
    daemonLabelTransport(
      "127.0.0.1:9999",
      "w1",
      { name: READY_LABEL, color: "emerald" },
      false,
    );

  it("completes the hello and assignment handshake", async () => {
    const promise = start();
    const socket = FakeSocket.instances[0];
    if (!socket) throw new Error("no socket");

    expect(socket.url).toBe("ws://127.0.0.1:9999/ws");
    socket.emit("open");
    expect(JSON.parse(socket.sent[0] ?? "")).toMatchObject({
      type: "hello",
      clientType: "cli",
      protocolVersion: 1,
    });

    socket.emitMessage({ message: { type: "status" } });
    const request = JSON.parse(socket.sent[1] ?? "") as {
      message: { requestId: string };
    };
    expect(request).toMatchObject({
      type: "session",
      message: {
        type: "workspace.label.assignment.set.request",
        workspaceId: "w1",
        assigned: false,
      },
    });

    socket.emitMessage({
      message: {
        type: "workspace.label.assignment.set.response",
        payload: { requestId: request.message.requestId },
      },
    });

    await expect(promise).resolves.toEqual({ kind: "ok" });
    expect(socket.closed).toBe(true);
  });

  it("reports an rpc_error as rejected", async () => {
    const promise = start();
    const socket = FakeSocket.instances[0];
    if (!socket) throw new Error("no socket");

    socket.emitMessage({
      message: {
        type: "rpc_error",
        payload: { error: "denied" },
      },
    });

    await expect(promise).resolves.toEqual({
      kind: "rejected",
      detail: "denied",
    });
  });

  it("reports a connection error as unreachable", async () => {
    const promise = start();
    FakeSocket.instances[0]?.emit("error");
    await expect(promise).resolves.toMatchObject({ kind: "unreachable" });
  });

  it("gives up when the daemon never answers", async () => {
    vi.useFakeTimers();
    const promise = start();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(promise).resolves.toMatchObject({ kind: "unreachable" });
  });
});
