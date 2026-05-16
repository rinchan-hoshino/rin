import path from "node:path";

import { isJsonRecord } from "../json-utils.js";
import {
  captureInternalRinCommand,
  createTargetExecutionContext,
  extractSubcommandArgv,
  ParsedArgs,
  safeString,
} from "./shared.js";
import { sleep } from "../platform/process.js";
import {
  canConnectDaemonSocket,
  requestDaemonCommand,
} from "../rin-daemon/client.js";

export type StatusCliOptions = {
  watch: boolean;
  intervalMs: number;
  json: boolean;
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
      "  --json               print the raw daemon_activity RPC snapshot",
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

export function parseStatusArgs(argv: string[]): StatusCliOptions {
  const args = extractSubcommandArgv(argv, "status");
  const result: StatusCliOptions = {
    watch: false,
    intervalMs: 1000,
    json: false,
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

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
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

function formatTime(value: unknown) {
  const text = safeString(value).trim();
  if (!text) return "-";
  const timestamp = Date.parse(text);
  if (Number.isNaN(timestamp)) return text;
  return new Date(timestamp).toLocaleString();
}

function pad(value: string, width: number) {
  if (value.length >= width) return value;
  return `${value}${" ".repeat(width - value.length)}`;
}

function truncate(value: string, width: number) {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

function renderTable(rows: Array<Record<string, string>>, columns: string[]) {
  if (!rows.length) return "  (none)";
  const widths = new Map<string, number>();
  for (const column of columns) widths.set(column, column.length);
  for (const row of rows) {
    for (const column of columns) {
      widths.set(
        column,
        Math.min(44, Math.max(widths.get(column) || 0, row[column].length)),
      );
    }
  }
  const header = columns
    .map((column) => pad(column, widths.get(column) || column.length))
    .join("  ");
  const divider = columns
    .map((column) => "-".repeat(widths.get(column) || column.length))
    .join("  ");
  const body = rows.map((row) =>
    columns
      .map((column) =>
        pad(
          truncate(row[column], widths.get(column) || column.length),
          widths.get(column) || column.length,
        ),
      )
      .join("  "),
  );
  return [
    `  ${header}`,
    `  ${divider}`,
    ...body.map((line) => `  ${line}`),
  ].join("\n");
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

function cronTaskState(task: Record<string, unknown>) {
  if (task.running) return "running";
  if (task.completedAt) return "completed";
  if (!task.enabled) return "paused";
  return task.nextRunAt ? "scheduled" : "idle";
}

function renderCronRows(tasks: unknown[]) {
  return tasks.map((task) => {
    const value = asRecord(task) ?? {};
    const target = asRecord(value.target);
    const session = asRecord(value.session);
    return {
      id: formatMaybe(value.id),
      state: cronTaskState(value),
      next: formatTime(value.nextRunAt),
      active: value.activeDurationMs
        ? formatDuration(value.activeDurationMs)
        : "-",
      runs: formatMaybe(value.runCount, "0"),
      session: formatMaybe(session?.mode),
      target: formatMaybe(target?.kind),
    };
  });
}

export function renderStatusReport(snapshot: unknown) {
  const status = asRecord(snapshot);
  if (!status) return "Rin daemon status: unavailable";

  const cron = asRecord(status.cron) ?? {};
  const workers = asArray(status.workers);
  const tasks = asArray(cron.tasks);
  const lines = [
    `Rin activity @ ${formatTime(status.generatedAt)}`,
    `socket: ${formatMaybe(status.socketPath)}`,
    "",
    `workers: ${String(status.workerCount ?? workers.length)} total, ${String(status.activeWorkerCount ?? 0)} active`,
    renderTable(renderWorkerRows(workers), [
      "id",
      "pid",
      "state",
      "attached",
      "pending",
      "idle",
      "session",
    ]),
    "",
    `cron: ${String(cron.taskCount ?? tasks.length)} tasks, ${String(cron.enabledTaskCount ?? 0)} enabled, ${String(cron.runningTaskCount ?? 0)} running, next ${formatTime(cron.nextRunAt)}`,
    renderTable(renderCronRows(tasks), [
      "id",
      "state",
      "next",
      "active",
      "runs",
      "session",
      "target",
    ]),
  ];
  return lines.join("\n");
}

async function queryActivity(socketPath?: string) {
  return await requestDaemonCommand(
    { id: "status_1", type: "daemon_activity" },
    { socketPath, timeoutMs: 1500 },
  );
}

async function renderOnce(options: StatusCliOptions, socketPath?: string) {
  const snapshot = await queryActivity(socketPath);
  return options.json ? JSON.stringify(snapshot) : renderStatusReport(snapshot);
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
  console.log(await renderOnce(options));
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
  console.log(await renderOnce(options, context.socketPath));
}
