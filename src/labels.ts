import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "./files.ts";
import type { Config } from "./types.ts";
import { workspaceStatePath } from "./workspaces.ts";

export const READY_LABEL = "ready-for-quality";

export const MERGE_WHEN_READY_LABEL = "merge-when-ready";

export const SUPPLY_CHAIN_INCIDENT_LABEL = "supply-chain-incident";

type LabelOutcome = { ok: boolean; detail: string };

type LabelDefinition = { name: string; color: string };

type DaemonLabelOutcome =
  | { kind: "ok" }
  | { kind: "rejected"; detail: string }
  | { kind: "unreachable"; detail: string };

export type LabelTransport = (
  endpoint: string,
  workspaceId: string,
  label: LabelDefinition,
  assigned: boolean,
) => Promise<DaemonLabelOutcome>;

type WorkspaceEntry = {
  workspaceId?: string;
  labels?: string[];
  [key: string]: unknown;
};

const REQUEST_TIMEOUT_MS = 5_000;
const PROTOCOL_VERSION = 1;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const readJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
};

const parseEntries = (json: string): WorkspaceEntry[] => {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error("workspaces.json does not contain an array");
  }
  return parsed as WorkspaceEntry[];
};

const LOCAL_HOSTS: Record<string, string> = {
  "0.0.0.0": "127.0.0.1",
  "::": "[::1]",
  "[::]": "[::1]",
};

const normalizeEndpoint = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const separator = trimmed.lastIndexOf(":");
  if (trimmed.includes("/") || separator <= 0) return null;
  const host = trimmed.slice(0, separator);
  const port = trimmed.slice(separator + 1);
  if (host === "" || port === "") return null;
  return `${LOCAL_HOSTS[host] ?? host}:${port}`;
};

/**
 * The live endpoint the daemon published (paseo.pid), falling back to the
 * configured one when the pid file is absent or stale.
 */
export const daemonEndpoint = async (
  paseoHome: string,
): Promise<string | null> => {
  const pid = (await readJson(`${paseoHome}/paseo.pid`)) as {
    listen?: unknown;
  } | null;
  const config = (await readJson(`${paseoHome}/config.json`)) as {
    daemon?: { listen?: unknown };
  } | null;
  return normalizeEndpoint(pid?.listen ?? config?.daemon?.listen);
};

export const labelDefinition = async (
  paseoHome: string,
  name: string,
): Promise<LabelDefinition | null> => {
  const catalog = await readJson(`${paseoHome}/projects/workspace-labels.json`);
  if (!Array.isArray(catalog)) return null;
  const entry = catalog.find(
    (item): item is LabelDefinition =>
      typeof item === "object" &&
      item !== null &&
      (item as LabelDefinition).name === name &&
      typeof (item as LabelDefinition).color === "string",
  );
  return entry ? { name, color: entry.color } : null;
};

type Incoming = {
  type?: string;
  payload?: { requestId?: unknown; error?: unknown };
};

const parseIncoming = (data: unknown): Incoming | null => {
  try {
    const parsed = JSON.parse(String(data)) as { message?: Incoming };
    return parsed.message ?? null;
  } catch {
    return null;
  }
};

/**
 * Paseo's daemon keeps `workspaces.json` in memory and never re-reads an
 * external edit, so the label must be changed through its websocket API to keep
 * the running app in sync.
 */
export const daemonLabelTransport: LabelTransport = (
  endpoint,
  workspaceId,
  label,
  assigned,
) =>
  new Promise((resolve) => {
    if (typeof WebSocket === "undefined") {
      resolve({ kind: "unreachable", detail: "WebSocket is unavailable" });
      return;
    }

    const socket = new WebSocket(`ws://${endpoint}/ws`);
    const requestId = randomUUID();
    let done = false;

    const finish = (outcome: DaemonLabelOutcome): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // The socket may already be closing; the outcome is decided.
      }
      resolve(outcome);
    };

    const timer = setTimeout(
      () => finish({ kind: "unreachable", detail: "Paseo daemon timed out" }),
      REQUEST_TIMEOUT_MS,
    );

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          type: "hello",
          clientId: "paseo-watch",
          clientType: "cli",
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
        }),
      );
    });

    socket.addEventListener("message", (event) => {
      const incoming = parseIncoming(event.data);
      if (incoming?.type === "status") {
        socket.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "workspace.label.assignment.set.request",
              requestId,
              workspaceId,
              label,
              assigned,
            },
          }),
        );
        return;
      }
      if (incoming?.type === "rpc_error") {
        finish({
          kind: "rejected",
          detail: String(
            incoming.payload?.error ?? "Paseo rejected the request",
          ),
        });
        return;
      }
      if (
        incoming?.type === "workspace.label.assignment.set.response" &&
        incoming.payload?.requestId === requestId
      ) {
        const error = incoming.payload?.error;
        finish(
          error === undefined
            ? { kind: "ok" }
            : { kind: "rejected", detail: String(error) },
        );
      }
    });

    socket.addEventListener("error", () =>
      finish({
        kind: "unreachable",
        detail: "Could not reach the Paseo daemon",
      }),
    );
    socket.addEventListener("close", () =>
      finish({
        kind: "unreachable",
        detail: "Paseo daemon closed the connection",
      }),
    );
  });

const changeDetail = (
  assigned: boolean,
  label: string,
  workspaceId: string,
): string =>
  `${assigned ? "Added" : "Removed"} ${label} ${
    assigned ? "to" : "from"
  } ${workspaceId}`;

const setViaDaemon = async (
  config: Config,
  workspaceId: string,
  label: string,
  assigned: boolean,
  transport: LabelTransport,
): Promise<DaemonLabelOutcome | null> => {
  const endpoint = await daemonEndpoint(config.paseoHome);
  if (endpoint === null) return null;
  const definition = await labelDefinition(config.paseoHome, label);
  if (definition === null) return null;
  return transport(endpoint, workspaceId, definition, assigned);
};

const setLabelInStateFile = async (
  config: Config,
  workspaceId: string,
  label: string,
  assigned: boolean,
): Promise<LabelOutcome> => {
  const path = workspaceStatePath(config.paseoHome);

  let entries: WorkspaceEntry[];
  try {
    entries = parseEntries(await readFile(path, "utf8"));
  } catch (error) {
    return { ok: false, detail: `Could not read ${path}: ${message(error)}` };
  }

  const entry = entries.find((item) => item.workspaceId === workspaceId);
  if (!entry) {
    return { ok: false, detail: `No workspace ${workspaceId} in ${path}` };
  }

  const labels = entry.labels ?? [];
  if (assigned === labels.includes(label)) {
    return {
      ok: true,
      detail: `${label} is already ${assigned ? "present" : "absent"}`,
    };
  }
  entry.labels = assigned
    ? [...labels, label]
    : labels.filter((item) => item !== label);

  try {
    await writeFileAtomic(path, `${JSON.stringify(entries, null, 2)}\n`);
  } catch (error) {
    return { ok: false, detail: `Could not write ${path}: ${message(error)}` };
  }

  return {
    ok: true,
    detail: changeDetail(assigned, label, workspaceId),
  };
};

export const setWorkspaceLabel = async (
  config: Config,
  workspaceId: string,
  label: string,
  assigned: boolean,
  transport: LabelTransport = daemonLabelTransport,
): Promise<LabelOutcome> => {
  const outcome = await setViaDaemon(
    config,
    workspaceId,
    label,
    assigned,
    transport,
  );
  if (outcome?.kind === "ok") {
    return {
      ok: true,
      detail: changeDetail(assigned, label, workspaceId),
    };
  }
  if (outcome?.kind === "rejected") {
    return { ok: false, detail: outcome.detail };
  }

  // No endpoint or catalog, or the daemon is unreachable: fall back to editing
  // the state file directly, which a later Paseo start will pick up.
  const fallback = await setLabelInStateFile(
    config,
    workspaceId,
    label,
    assigned,
  );
  if (outcome?.kind === "unreachable" && fallback.ok) {
    return { ok: true, detail: `${fallback.detail} (daemon unreachable)` };
  }
  return fallback;
};

export const removeWorkspaceLabel = (
  config: Config,
  workspaceId: string,
  label: string,
  transport: LabelTransport = daemonLabelTransport,
): Promise<LabelOutcome> =>
  setWorkspaceLabel(config, workspaceId, label, false, transport);
