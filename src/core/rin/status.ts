import path from "node:path";

import { asArray, isJsonRecord } from "../json-utils.js";
import {
  captureInternalRinCommand,
  createTargetExecutionContext,
  extractSubcommandArgv,
  ParsedArgs,
  safeString,
} from "./shared.js";
import { formatReportTime } from "./report-format.js";
import {
  canConnectDaemonSocket,
  requestDaemonCommand,
} from "../rin-daemon/client.js";
import { runInteractiveList } from "./interactive-list.js";

export type StatusCliOptions = {
  watch: boolean;
  once: boolean;
  intervalMs: number;
  json: boolean;
  limit: number;
  offset: number;
  help: boolean;
};

type StatusItem = {
  id: string;
  kind: "worker" | "task";
  marker: string;
  state: string;
  summary: string;
  meta: string;
  detail: string[];
};

function printStatusHelp() {
  console.log(
    [
      "rin status [options]",
      "",
      "Default view:",
      "  Opens an interactive, auto-refreshing TUI when stdout is a terminal.",
      "  Use ↑/↓ or j/k to move, Enter/Space to expand details, q or Ctrl+C to exit.",
      "",
      "Options:",
      "  --once               print one non-interactive snapshot",
      "  --watch              open the interactive live view (default on TTY)",
      "  --interval <sec>     refresh interval in seconds (default 1)",
      "  --json               print backend daemon activity plus session listing",
      "  --limit <n>          backend session page size (default 50)",
      "  --offset <n>         backend session page offset (default 0)",
      "  --help               show this help",
      "",
      "Examples:",
      "  rin status",
      "  rin status --once",
      "  rin status --json",
    ].join("\n"),
  );
}

function readStatusArg(args: string[], index: number) {
  return safeString(args[index]).trim();
}

function parseIntervalMs(value: string) {
  const text = safeString(value).trim();
  if (!text) throw new Error("missing_status_interval");
  const seconds = Number(text);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`invalid_status_interval:${text}`);
  }
  return Math.max(100, Math.round(seconds * 1000));
}

function parseNonNegativeInt(value: string, name: string) {
  const text = safeString(value).trim();
  const num = Number(text);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(`invalid_status_${name}:${text}`);
  }
  return Math.round(num);
}

export function parseStatusArgs(argv: string[]): StatusCliOptions {
  const args = extractSubcommandArgv(argv, "status");
  const result: StatusCliOptions = {
    watch: true,
    once: false,
    intervalMs: 1000,
    json: false,
    limit: 50,
    offset: 0,
    help: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--watch" || arg === "-w") {
      result.watch = true;
      result.once = false;
      continue;
    }
    if (arg === "--once") {
      result.once = true;
      result.watch = false;
      continue;
    }
    if (arg === "--json") {
      result.json = true;
      result.once = true;
      result.watch = false;
      continue;
    }
    if (arg === "--limit") {
      const next = readStatusArg(args, i + 1);
      if (!next || next.startsWith("--"))
        throw new Error("missing_status_limit");
      i += 1;
      result.limit = Math.max(1, parseNonNegativeInt(next, "limit"));
      continue;
    }
    if (arg.startsWith("--limit=")) {
      result.limit = Math.max(
        1,
        parseNonNegativeInt(arg.slice("--limit=".length), "limit"),
      );
      continue;
    }
    if (arg === "--offset") {
      const next = readStatusArg(args, i + 1);
      if (!next || next.startsWith("--"))
        throw new Error("missing_status_offset");
      i += 1;
      result.offset = parseNonNegativeInt(next, "offset");
      continue;
    }
    if (arg.startsWith("--offset=")) {
      result.offset = parseNonNegativeInt(
        arg.slice("--offset=".length),
        "offset",
      );
      continue;
    }
    if (arg === "--interval") {
      const next = readStatusArg(args, i + 1);
      if (!next || next.startsWith("--"))
        throw new Error("missing_status_interval");
      i += 1;
      result.intervalMs = parseIntervalMs(next);
      continue;
    }
    if (arg.startsWith("--interval=")) {
      result.intervalMs = parseIntervalMs(arg.slice("--interval=".length));
      continue;
    }
    throw new Error(`unknown_status_arg:${arg}`);
  }
  return result;
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return isJsonRecord(value) ? value : undefined;
}

function formatMaybe(value: unknown, fallback = "-") {
  const text = safeString(value).trim();
  return text || fallback;
}

function formatStatusUnavailable(options: Pick<StatusCliOptions, "json">) {
  return options.json
    ? JSON.stringify({ error: "rin_daemon_unavailable" })
    : "Rin daemon status: unavailable";
}

function formatStatusRequestFailure(
  options: Pick<StatusCliOptions, "json">,
  error: unknown,
) {
  const detail = safeString(error).trim() || "daemon_request_failed";
  const message = `Rin daemon status: unavailable (${detail})`;
  return options.json ? JSON.stringify({ error: message }) : message;
}

function formatDuration(ms: unknown) {
  const value = Number(ms || 0);
  if (!Number.isFinite(value) || value <= 0) return "-";
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m${rest.toString().padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${(minutes % 60).toString().padStart(2, "0")}m`;
}

const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_COLOR_PATTERN = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, "g");

function stripAnsi(value: string) {
  return value.replace(ANSI_COLOR_PATTERN, "");
}

function truncate(value: string, width: number) {
  const clean = stripAnsi(value);
  if (clean.length <= width) return value;
  if (width <= 1) return clean.slice(0, width);
  return `${clean.slice(0, width - 1)}…`;
}

function pad(value: string, width: number) {
  const clean = stripAnsi(value);
  if (clean.length >= width) return truncate(value, width);
  return `${value}${" ".repeat(width - clean.length)}`;
}

function statusDot(state: string) {
  if (state === "working" || state === "compacting") return "●";
  if (state === "stopping") return "◒";
  if (state === "idle") return "○";
  return "◌";
}

function sessionLabel(value: unknown) {
  const text = safeString(value).trim();
  if (!text) return "-";
  return text.replace(/\\/g, "/").replace(/^.*\/sessions\//, "sessions/");
}

function isRunningWorker(worker: unknown) {
  const value = asRecord(worker) ?? {};
  const state = safeString(value.state).trim();
  return (
    state === "working" ||
    state === "compacting" ||
    state === "stopping" ||
    Boolean(value.rinWorking)
  );
}

function workerItem(worker: unknown): StatusItem {
  const value = asRecord(worker) ?? {};
  const state = formatMaybe(value.state, "attached");
  const flags = [
    value.turnActive ? "turn" : "",
    value.isStreaming ? "stream" : "",
    value.isCompacting ? "compact" : "",
    value.rinWorking ? "rin" : "",
  ].filter(Boolean);
  const idle = value.idleSince
    ? formatDuration(Date.now() - Number(value.idleSince))
    : "-";
  const session = sessionLabel(value.sessionFile || value.sessionId);
  return {
    id: formatMaybe(value.id),
    kind: "worker",
    marker: `W ${statusDot(state)}`,
    state,
    summary: `${formatMaybe(value.id)}  ${state}`,
    meta: `pid ${formatMaybe(value.pid)} · conn ${formatMaybe(value.attachedConnections, "0")} · pend ${formatMaybe(value.pendingResponses, "0")} · idle ${idle} · ${flags.join(",") || "-"}`,
    detail: [
      `worker      ${formatMaybe(value.id)}`,
      `state       ${state}`,
      `pid         ${formatMaybe(value.pid)}`,
      `connections ${formatMaybe(value.attachedConnections, "0")}`,
      `pending     ${formatMaybe(value.pendingResponses, "0")}`,
      `flags       ${flags.join(", ") || "-"}`,
      `session     ${session}`,
    ],
  };
}

function taskItem(task: unknown): StatusItem {
  const value = asRecord(task) ?? {};
  const running = Boolean(value.running);
  const enabled = Boolean(value.enabled) && !value.completedAt;
  const state = running ? "running" : enabled ? "enabled" : "stopped";
  const active = running ? formatDuration(value.activeDurationMs) : "-";
  const target = asRecord(value.target)?.kind || value.targetKind || "-";
  const session = asRecord(value.session)?.mode || "-";
  const next = formatMaybe(value.nextRunAt);
  const last = formatMaybe(value.lastFinishedAt || value.lastStartedAt);
  return {
    id: formatMaybe(value.id),
    kind: "task",
    marker: `T ${running ? "●" : enabled ? "○" : "◌"}`,
    state,
    summary: `${formatMaybe(value.name || value.id)}  ${state}`,
    meta: `next ${next} · active ${active} · runs ${formatMaybe(value.runCount, "0")} · ${target}`,
    detail: [
      `task        ${formatMaybe(value.id)}`,
      `state       ${state}`,
      `target      ${target}`,
      `session     ${session}`,
      `next        ${next}`,
      `last        ${last}`,
      `active      ${active}`,
      `runs        ${formatMaybe(value.runCount, "0")}`,
    ],
  };
}

function buildStatusItems(snapshot: unknown) {
  const status = asRecord(snapshot) ?? {};
  const workers = asArray(status.workers).map(workerItem);
  const tasks = asArray(asRecord(status.cron)?.tasks)
    .map(taskItem)
    .sort((a, b) => {
      const priority = (item: StatusItem) =>
        item.state === "running" ? 0 : item.state === "enabled" ? 1 : 2;
      return priority(a) - priority(b) || a.id.localeCompare(b.id);
    });
  return [...workers, ...tasks];
}

function renderStatusDetail(item: StatusItem | undefined, width: number) {
  const lines = item?.detail.length
    ? item.detail
    : ["select a row for details"];
  return lines.map((line) => `  ${truncate(line, width - 2)}`).join("\n");
}

function renderStatusRows(
  items: StatusItem[],
  selectedIndex: number,
  width: number,
  maxRows: number,
) {
  if (!items.length) return "  no workers or scheduled tasks";
  const start = clampViewportStart(selectedIndex, items.length, maxRows);
  const visible = items.slice(start, start + maxRows);
  return visible
    .map((item, offset) => {
      const index = start + offset;
      const selected = index === selectedIndex;
      const prefix = selected ? "▶" : " ";
      const line = `${prefix} ${pad(item.marker, 4)} ${pad(item.summary, 34)} ${item.meta}`;
      return truncate(line, width);
    })
    .join("\n");
}

function clampViewportStart(
  selectedIndex: number,
  count: number,
  maxRows: number,
) {
  if (count <= maxRows) return 0;
  const half = Math.floor(maxRows / 2);
  return Math.min(Math.max(0, selectedIndex - half), count - maxRows);
}

function summaryLine(snapshot: unknown) {
  const status = asRecord(snapshot) ?? {};
  const workers = asArray(status.workers);
  const activeWorkers = workers.filter(isRunningWorker).length;
  const cron = asRecord(status.cron) ?? {};
  return [
    `workers ${activeWorkers}/${formatMaybe(status.workerCount ?? workers.length, "0")}`,
    `tasks ${formatMaybe(cron.runningTaskCount, "0")}/${formatMaybe(cron.enabledTaskCount, "0")} running/enabled`,
    `next ${formatMaybe(cron.nextRunAt)}`,
    `socket ${formatMaybe(status.socketPath)}`,
  ].join("  │  ");
}

export function renderStatusTui(
  snapshot: unknown,
  state: { selectedIndex?: number; expanded?: boolean } = {},
  options: { width?: number; height?: number; interactive?: boolean } = {},
) {
  const width = Math.max(
    60,
    Math.min(160, options.width || process.stdout.columns || 100),
  );
  const height = Math.max(16, options.height || process.stdout.rows || 30);
  const items = buildStatusItems(snapshot);
  const selectedIndex = Math.min(
    Math.max(0, state.selectedIndex || 0),
    Math.max(0, items.length - 1),
  );
  const selected = items[selectedIndex];
  const status = asRecord(snapshot) ?? {};
  const detailRows = state.expanded ? Math.max(6, height - 8) : 8;
  const listRows = state.expanded ? 0 : Math.max(5, height - detailRows - 7);
  const headerRight = formatReportTime(status.generatedAt);
  const title = "Rin Status";
  const header = `${title}${" ".repeat(Math.max(1, width - title.length - headerRight.length))}${headerRight}`;
  const hints = options.interactive
    ? "↑/↓ j/k move · PgUp/PgDn · Enter/Space detail · q/Ctrl+C quit"
    : "snapshot view · use `rin status` in a terminal for live TUI · `rin status --json` for backend";
  const body = state.expanded
    ? renderStatusDetail(selected, width)
    : renderStatusRows(items, selectedIndex, width, listRows);
  const detail = state.expanded
    ? ""
    : ["", "Details", renderStatusDetail(selected, width)].join("\n");
  return [
    header,
    truncate(summaryLine(snapshot), width),
    truncate(hints, width),
    "─".repeat(width),
    body,
    detail,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function renderStatusReport(snapshot: unknown) {
  if (!asRecord(snapshot)) return "Rin session status: unavailable";
  return renderStatusTui(snapshot, {}, { interactive: false });
}

const STATUS_REQUEST_TIMEOUT_MS = 8_000;

async function queryActivity(socketPath?: string) {
  return await requestDaemonCommand(
    { id: "status_1", type: "daemon_activity" },
    { socketPath, timeoutMs: STATUS_REQUEST_TIMEOUT_MS },
  );
}

async function querySessionPage(
  options: StatusCliOptions,
  socketPath?: string,
) {
  return await requestDaemonCommand(
    {
      id: "status_sessions_1",
      type: "list_sessions",
      limit: options.limit,
      offset: options.offset,
    },
    { socketPath, timeoutMs: STATUS_REQUEST_TIMEOUT_MS },
  );
}

async function queryStatusBackend(
  options: StatusCliOptions,
  socketPath?: string,
) {
  const [activity, sessions] = await Promise.all([
    queryActivity(socketPath),
    querySessionPage(options, socketPath),
  ]);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    activity,
    sessions,
  };
}

async function renderOnce(options: StatusCliOptions, socketPath?: string) {
  if (options.json)
    return JSON.stringify(await queryStatusBackend(options, socketPath));
  const snapshot = await queryActivity(socketPath);
  return renderStatusReport(snapshot);
}

async function runStatusTui(options: StatusCliOptions, socketPath?: string) {
  const opened = await runInteractiveList({
    intervalMs: options.intervalMs,
    render: async (state) => {
      const snapshot = await queryActivity(socketPath);
      return {
        content: renderStatusTui(snapshot, state, { interactive: true }),
        itemCount: buildStatusItems(snapshot).length,
      };
    },
  });
  if (!opened) await printStatusOnce(options, socketPath);
}

async function printStatusOnce(options: StatusCliOptions, socketPath?: string) {
  try {
    console.log(await renderOnce(options, socketPath));
  } catch (error: any) {
    console.log(formatStatusRequestFailure(options, error?.message || error));
  }
}

export async function runStatusInternal(rawArgv: string[]) {
  const options = parseStatusArgs(rawArgv);
  if (options.help) {
    printStatusHelp();
    return;
  }
  if (!(await canConnectDaemonSocket(undefined, 500))) {
    console.log(formatStatusUnavailable(options));
    return;
  }
  if (!options.once && !options.json) return await runStatusTui(options);
  await printStatusOnce(options);
}

export async function runStatus(parsed: ParsedArgs, rawArgv: string[]) {
  const options = parseStatusArgs(rawArgv);
  if (options.help) {
    printStatusHelp();
    return;
  }
  const context = createTargetExecutionContext(parsed);
  if (!context.isTargetUser) {
    if (!options.once && !options.json) {
      context.exec([
        process.execPath,
        path.join(context.repoRoot, "dist", "app", "rin", "main.js"),
        "__status_internal",
        ...extractSubcommandArgv(rawArgv, "status"),
      ]);
      return;
    }
    const forwarded = captureInternalRinCommand(
      context,
      "__status_internal",
      rawArgv,
      "status",
    );
    process.stdout.write(forwarded);
    return;
  }
  if (!(await context.canConnectSocket())) {
    console.log(formatStatusUnavailable(options));
    return;
  }
  if (!options.once && !options.json)
    return await runStatusTui(options, context.socketPath);
  await printStatusOnce(options, context.socketPath);
}
