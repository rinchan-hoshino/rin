import path from "node:path";

import { asArray, isJsonRecord } from "../json-utils.js";
import {
  captureInternalRinCommand,
  createTargetExecutionContext,
  extractSubcommandArgv,
  ParsedArgs,
  safeString,
} from "./shared.js";
import { sleep } from "../platform/process.js";
import { formatReportTime, renderReportTable } from "./report-format.js";
import {
  canConnectDaemonSocket,
  requestDaemonCommand,
} from "../rin-daemon/client.js";

export type StatusCliOptions = {
  watch: boolean;
  intervalMs: number;
  json: boolean;
  limit: number;
  offset: number;
  help: boolean;
};

function printStatusHelp() {
  console.log(
    [
      "rin status [options]",
      "",
      "Options:",
      "  --watch              refresh the status view until interrupted",
      "  --interval <sec>     watch refresh interval in seconds (default 1)",
      "  --json               print backend daemon activity plus session listing",
      "  --limit <n>          backend session page size (default 50)",
      "  --offset <n>         backend session page offset (default 0)",
      "  --help               show this help",
      "",
      "Examples:",
      "  rin status",
      "  rin status --watch",
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
    watch: false,
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
      continue;
    }
    if (arg === "--json") {
      result.json = true;
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

function renderWorkerRows(workers: unknown[]) {
  return workers.map((worker) => {
    const value = asRecord(worker) ?? {};
    const session = safeString(value.sessionFile || value.sessionId).trim();
    return {
      id: formatMaybe(value.id),
      pid: formatMaybe(value.pid),
      state: formatMaybe(value.state),
      attached: formatMaybe(value.attachedConnections, "0"),
      pending: formatMaybe(value.pendingResponses, "0"),
      idle: value.idleSince
        ? formatDuration(Date.now() - Number(value.idleSince))
        : "-",
      session: session ? session.replace(/^.*\/sessions\//, "sessions/") : "-",
    };
  });
}

function isRunningWorker(worker: unknown) {
  const value = asRecord(worker) ?? {};
  const state = safeString(value.state).trim();
  return (
    state === "working" || state === "stopping" || Boolean(value.rinWorking)
  );
}

export function renderStatusReport(snapshot: unknown) {
  const status = asRecord(snapshot);
  if (!status) return "Rin session status: unavailable";

  const workers = asArray(status.workers);
  const runningWorkers = workers.filter(isRunningWorker);
  const lines = [
    `Rin running sessions @ ${formatReportTime(status.generatedAt)}`,
    `socket: ${formatMaybe(status.socketPath)}`,
    `running: ${String(runningWorkers.length)} / ${String(status.workerCount ?? workers.length)} sessions`,
    "",
    renderReportTable(
      renderWorkerRows(runningWorkers),
      ["id", "pid", "state", "attached", "pending", "idle", "session"],
      {
        emptyText: "no running sessions",
        indent: "  ",
        maxColumnWidth: 44,
      },
    ),
  ];
  return lines.join("\n");
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

async function runStatusLoop(options: StatusCliOptions, socketPath?: string) {
  while (true) {
    try {
      const output = await renderOnce(options, socketPath);
      if (options.json) {
        console.log(output);
      } else {
        process.stdout.write("\x1b[2J\x1b[H");
        console.log(output);
        console.log("\nPress Ctrl+C to stop.");
      }
    } catch (error: any) {
      const message = formatStatusRequestFailure(
        options,
        error?.message || error,
      );
      if (options.json) console.log(message);
      else {
        process.stdout.write("\x1b[2J\x1b[H");
        console.log(message);
        console.log("\nPress Ctrl+C to stop.");
      }
    }
    await sleep(options.intervalMs);
  }
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
  if (options.watch) return await runStatusLoop(options);
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
    if (options.watch) {
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
  if (options.watch) return await runStatusLoop(options, context.socketPath);
  await printStatusOnce(options, context.socketPath);
}
