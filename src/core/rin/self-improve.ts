import fs from "node:fs";
import path from "node:path";

import {
  captureInternalRinCommand,
  createTargetExecutionContext,
  extractSubcommandArgv,
  ParsedArgs,
  safeString,
} from "./shared.js";
import { maintenanceHistoryPath } from "../self-improve/paths.js";
import { nowIso } from "../time-utils.js";
import { formatReportTime, renderReportTable } from "./report-format.js";
import { runInteractiveList } from "./interactive-list.js";

export type SelfImproveCliOptions = {
  from?: string;
  to?: string;
  limit: number;
  explicitLimit: boolean;
  status?: string;
  trigger?: string;
  id?: string;
  once: boolean;
  watch: boolean;
  intervalMs: number;
  json: boolean;
  help: boolean;
};

type MaintenanceHistoryRecord = {
  id?: string;
  kind?: string;
  status?: string;
  trigger?: string;
  sessionFile?: string;
  leafId?: string;
  snapshotKey?: string;
  startedAt?: string;
  finishedAt?: string;
  attempts?: number;
  skipped?: string;
  error?: string;
  outputPreview?: string;
  changedFiles?: Array<{ path?: string; change?: string }>;
};

type SelfImproveItem = {
  id: string;
  state: string;
  title: string;
  meta: string;
  detail: string[];
};

function printSelfImproveHelp() {
  console.log(
    [
      "rin self-improve [options]",
      "",
      "Default view:",
      "  Opens an interactive Pi resume-list style TUI for recent self-improve runs.",
      "  Use ↑/↓ or j/k to move, Enter/Space to expand details, q or Ctrl+C to exit.",
      "",
      "Options:",
      "  --once              print one non-interactive text snapshot",
      "  --watch             open the interactive live view (default on TTY)",
      "  --interval <sec>    refresh interval in seconds (default 2)",
      "  --id <id>           print details for one self-improve run",
      "  --json              backend view with complete filtered records and stats",
      "  --from <time>       start time (ISO, YYYY-MM-DD, 24h, 7d, 30m)",
      "  --to <time>         end time (ISO, YYYY-MM-DD, 24h, 7d, 30m)",
      "  --limit <n>         run limit for text/backend views (default 20)",
      "  --status <status>   filter: completed or failed",
      "  --trigger <text>    substring filter for trigger",
      "  --help              show this help",
      "",
      "Examples:",
      "  rin self-improve",
      "  rin self-improve --once",
      "  rin self-improve --id run-20260623",
      "  rin self-improve --json --from 30d --status failed",
    ].join("\n"),
  );
}

function parsePositiveInt(value: string, fallback: number) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.round(num);
}

function parseIntervalMs(value: string) {
  const text = safeString(value).trim();
  if (!text) throw new Error("missing_self_improve_interval");
  const seconds = Number(text);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`invalid_self_improve_interval:${text}`);
  }
  return Math.max(100, Math.round(seconds * 1000));
}

function normalizeTimeArg(
  input: string | undefined,
  boundary: "start" | "end",
) {
  const raw = safeString(input).trim();
  if (!raw) return undefined;
  const relative = raw.match(/^(\d+)([mhdw])$/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const deltaMs =
      unit === "m"
        ? amount * 60_000
        : unit === "h"
          ? amount * 3_600_000
          : unit === "d"
            ? amount * 86_400_000
            : amount * 7 * 86_400_000;
    return new Date(Date.now() - deltaMs).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return boundary === "start"
      ? `${raw}T00:00:00.000Z`
      : `${raw}T23:59:59.999Z`;
  }
  const date = new Date(raw);
  if (!Number.isNaN(date.getTime())) return date.toISOString();
  throw new Error(`invalid_time:${raw}`);
}

function readArg(args: string[], index: number) {
  return safeString(args[index]).trim();
}

export function parseSelfImproveArgs(argv: string[]): SelfImproveCliOptions {
  const args = extractSubcommandArgv(argv, "self-improve");
  const result: SelfImproveCliOptions = {
    limit: 20,
    explicitLimit: false,
    once: false,
    watch: true,
    intervalMs: 2000,
    json: false,
    help: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--once") {
      result.once = true;
      result.watch = false;
      continue;
    }
    if (arg === "--watch" || arg === "-w") {
      result.once = false;
      result.watch = true;
      continue;
    }
    if (arg === "--json") {
      result.json = true;
      result.once = true;
      result.watch = false;
      continue;
    }
    if (arg === "--id") {
      result.id = readArg(args, ++i);
      result.once = true;
      result.watch = false;
      continue;
    }
    if (arg === "--from") {
      result.from = normalizeTimeArg(readArg(args, ++i), "start");
      continue;
    }
    if (arg === "--to") {
      result.to = normalizeTimeArg(readArg(args, ++i), "end");
      continue;
    }
    if (arg === "--limit") {
      result.limit = parsePositiveInt(readArg(args, ++i), result.limit);
      result.explicitLimit = true;
      continue;
    }
    if (arg === "--status") {
      result.status = readArg(args, ++i);
      continue;
    }
    if (arg === "--trigger") {
      result.trigger = readArg(args, ++i);
      continue;
    }
    if (arg === "--interval") {
      result.intervalMs = parseIntervalMs(readArg(args, ++i));
      continue;
    }
    if (arg.startsWith("--interval=")) {
      result.intervalMs = parseIntervalMs(arg.slice("--interval=".length));
      continue;
    }
    throw new Error(`unknown_self_improve_arg:${arg}`);
  }
  return result;
}

function parseRecord(line: string): MaintenanceHistoryRecord | undefined {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

function readHistory(agentDir: string): MaintenanceHistoryRecord[] {
  const filePath = maintenanceHistoryPath(agentDir);
  if (!filePath || !fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseRecord)
    .filter((record): record is MaintenanceHistoryRecord => Boolean(record));
}

function recordTime(record: MaintenanceHistoryRecord) {
  return safeString(record.finishedAt || record.startedAt).trim();
}

function recordTimestamp(record: MaintenanceHistoryRecord) {
  const timestamp = Date.parse(recordTime(record));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function inRange(
  record: MaintenanceHistoryRecord,
  options: SelfImproveCliOptions,
) {
  const timestamp = recordTimestamp(record);
  if (options.from && timestamp < Date.parse(options.from)) return false;
  if (options.to && timestamp > Date.parse(options.to)) return false;
  if (options.status && safeString(record.status).trim() !== options.status) {
    return false;
  }
  if (options.id && safeString(record.id).trim() !== options.id) {
    return false;
  }
  if (
    options.trigger &&
    !safeString(record.trigger).includes(options.trigger)
  ) {
    return false;
  }
  return true;
}

function changedFileSummary(record: MaintenanceHistoryRecord, max = 4) {
  const files = Array.isArray(record.changedFiles) ? record.changedFiles : [];
  if (!files.length) return "-";
  const visible = files
    .slice(0, max)
    .map((file) => {
      const change = safeString(file.change).trim() || "updated";
      const path = safeString(file.path).trim();
      return path ? `${change}:${path}` : change;
    })
    .filter(Boolean);
  const more =
    files.length > visible.length ? ` +${files.length - visible.length}` : "";
  return `${visible.join(", ")}${more}`;
}

function sessionLabel(value: unknown) {
  const text = safeString(value).trim();
  if (!text) return "-";
  const parts = text.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(-2).join("/") || text;
}

function summarize(records: MaintenanceHistoryRecord[]) {
  const completed = records.filter(
    (record) => record.status === "completed",
  ).length;
  const failed = records.filter((record) => record.status === "failed").length;
  const changedFiles = records.reduce(
    (total, record) =>
      total +
      (Array.isArray(record.changedFiles) ? record.changedFiles.length : 0),
    0,
  );
  return [
    "overview",
    `  runs      ${records.length} total · ${completed} completed · ${failed} failed`,
    `  changes   ${changedFiles} changed file records`,
    records.length
      ? `  range     ${recordTime(records.at(-1) || {}) || "-"} .. ${recordTime(records[0] || {}) || "-"}`
      : "  range     -",
  ].join("\n");
}

function renderRecentRuns(records: MaintenanceHistoryRecord[]) {
  return renderReportTable(
    records.map((record) => ({
      finished: formatReportTime(record.finishedAt || record.startedAt),
      status: record.status || "-",
      trigger: record.trigger || "-",
      session: sessionLabel(record.sessionFile),
      attempts: String(record.attempts || 1),
      changed: changedFileSummary(record),
      error: record.error || record.skipped || "",
    })),
    [
      "finished",
      "status",
      "trigger",
      "session",
      "attempts",
      "changed",
      "error",
    ],
    { emptyText: "no self-improve distillation runs found" },
  );
}

function frontendFromIso() {
  return new Date(Date.now() - 24 * 3_600_000).toISOString();
}

function querySelfImproveRecords(
  agentDir: string,
  options: SelfImproveCliOptions,
) {
  return readHistory(agentDir)
    .filter((record) => inRange(record, options))
    .sort((a, b) => recordTimestamp(b) - recordTimestamp(a));
}

function renderSelfImproveList(records: MaintenanceHistoryRecord[]) {
  if (!records.length) return "  no self-improve outcomes in this window";
  return records
    .map((record, index) => {
      const id = safeString(record.id).trim() || `#${index + 1}`;
      const changed = changedFileSummary(record);
      const error = record.error || record.skipped;
      return [
        `${String(index + 1).padStart(2, " ")}. ${formatReportTime(record.finishedAt || record.startedAt)}  ${record.status || "-"}  ${record.trigger || "-"}`,
        `    id ${id} · session ${sessionLabel(record.sessionFile)} · attempts ${String(record.attempts || 1)}`,
        `    changed ${changed}`,
        error ? `    note ${error}` : undefined,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
}

function renderSelfImproveDetail(record: MaintenanceHistoryRecord | undefined) {
  if (!record) return "Self-improve run not found";
  const changedFiles = Array.isArray(record.changedFiles)
    ? record.changedFiles
    : [];
  const lines = [
    `Rin self-improve detail: ${safeString(record.id).trim() || "(no id)"}`,
    `status: ${record.status || "-"}`,
    `trigger: ${record.trigger || "-"}`,
    `session: ${sessionLabel(record.sessionFile)}`,
    `started: ${formatReportTime(record.startedAt)}`,
    `finished: ${formatReportTime(record.finishedAt)}`,
    `attempts: ${String(record.attempts || 1)}`,
  ];
  if (record.error || record.skipped) {
    lines.push(`note: ${record.error || record.skipped}`);
  }
  lines.push(
    "",
    "changed files:",
    ...(changedFiles.length
      ? changedFiles.map(
          (file) =>
            `  - ${(safeString(file.change).trim() || "updated").padEnd(8)} ${safeString(file.path).trim() || "-"}`,
        )
      : ["  (none)"]),
  );
  if (record.outputPreview) {
    lines.push("", "output preview:", record.outputPreview);
  }
  return lines.join("\n");
}

export function buildSelfImproveBackendReport(
  agentDir: string,
  options: SelfImproveCliOptions,
) {
  const records = querySelfImproveRecords(agentDir, options);
  const returnedRecords = options.explicitLimit
    ? records.slice(0, options.limit)
    : records;
  const completed = records.filter(
    (record) => record.status === "completed",
  ).length;
  const failed = records.filter((record) => record.status === "failed").length;
  const changedFiles = records.reduce(
    (total, record) =>
      total +
      (Array.isArray(record.changedFiles) ? record.changedFiles.length : 0),
    0,
  );
  return {
    generatedAt: nowIso(),
    filters: {
      from: options.from,
      to: options.to,
      status: options.status,
      trigger: options.trigger,
      id: options.id,
      limit: options.explicitLimit ? options.limit : undefined,
    },
    stats: {
      totalRuns: records.length,
      completed,
      failed,
      changedFiles,
      first: recordTime(records.at(-1) || {}) || undefined,
      last: recordTime(records[0] || {}) || undefined,
    },
    records: returnedRecords,
  };
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

function statusDot(status: string) {
  if (status === "completed") return "●";
  if (status === "failed") return "✖";
  if (status === "skipped") return "◌";
  return "○";
}

function selfImproveItem(
  record: MaintenanceHistoryRecord,
  index: number,
): SelfImproveItem {
  const id = safeString(record.id).trim() || `#${index + 1}`;
  const state = safeString(record.status).trim() || "unknown";
  const changedCount = Array.isArray(record.changedFiles)
    ? record.changedFiles.length
    : 0;
  const time = formatReportTime(record.finishedAt || record.startedAt);
  return {
    id,
    state,
    title: `${time}  ${state}  ${safeString(record.trigger).trim() || "-"}`,
    meta: `id ${id} · changes ${changedCount} · attempts ${String(record.attempts || 1)} · ${sessionLabel(record.sessionFile)}`,
    detail: renderSelfImproveDetail(record).split("\n"),
  };
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

function renderItems(
  items: SelfImproveItem[],
  selectedIndex: number,
  width: number,
  maxRows: number,
) {
  if (!items.length) return "  no self-improve outcomes in this window";
  const start = clampViewportStart(selectedIndex, items.length, maxRows);
  return items
    .slice(start, start + maxRows)
    .map((item, offset) => {
      const index = start + offset;
      const selected = index === selectedIndex;
      const prefix = selected ? "▶" : " ";
      const line = `${prefix} ${statusDot(item.state)} ${pad(item.title, 58)} ${item.meta}`;
      return truncate(line, width);
    })
    .join("\n");
}

function renderDetail(item: SelfImproveItem | undefined, width: number) {
  const lines = item?.detail.length
    ? item.detail
    : ["select a run for details"];
  return lines.map((line) => `  ${truncate(line, width - 2)}`).join("\n");
}

function tuiRecords(agentDir: string, options: SelfImproveCliOptions) {
  return querySelfImproveRecords(agentDir, {
    ...options,
    from: options.from || frontendFromIso(),
    id: undefined,
  });
}

export function renderSelfImproveTui(
  agentDir: string,
  options: SelfImproveCliOptions,
  state: { selectedIndex?: number; expanded?: boolean } = {},
  renderOptions: {
    width?: number;
    height?: number;
    interactive?: boolean;
  } = {},
) {
  const width = Math.max(
    70,
    Math.min(180, renderOptions.width || process.stdout.columns || 110),
  );
  const height = Math.max(
    16,
    renderOptions.height || process.stdout.rows || 30,
  );
  const records = tuiRecords(agentDir, options);
  const items = records.map(selfImproveItem);
  const selectedIndex = Math.min(
    Math.max(0, state.selectedIndex || 0),
    Math.max(0, items.length - 1),
  );
  const selected = items[selectedIndex];
  const completed = records.filter(
    (record) => record.status === "completed",
  ).length;
  const failed = records.filter((record) => record.status === "failed").length;
  const changed = records.reduce(
    (total, record) =>
      total +
      (Array.isArray(record.changedFiles) ? record.changedFiles.length : 0),
    0,
  );
  const detailRows = state.expanded ? Math.max(6, height - 8) : 9;
  const listRows = state.expanded ? 0 : Math.max(5, height - detailRows - 7);
  const title = "Self-Improve Runs";
  const headerRight = formatReportTime(nowIso());
  const header = `${title}${" ".repeat(Math.max(1, width - title.length - headerRight.length))}${headerRight}`;
  const scope = `${records.length} runs · ${completed} completed · ${failed} failed · ${changed} file changes`;
  const filters = [
    options.from ? `from ${options.from}` : "past 1d",
    options.to ? `to ${options.to}` : "",
    options.status ? `status ${options.status}` : "",
    options.trigger ? `trigger ${options.trigger}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const hints = renderOptions.interactive
    ? "↑/↓ j/k move · PgUp/PgDn · Enter/Space detail · q/Ctrl+C quit"
    : "snapshot view · use `rin self-improve` in a terminal for list TUI · `--json` for backend";
  const body = state.expanded
    ? renderDetail(selected, width)
    : renderItems(items, selectedIndex, width, listRows);
  const detail = state.expanded
    ? ""
    : ["", "Details", renderDetail(selected, width)].join("\n");
  return [
    header,
    truncate(`${scope}  │  ${filters}`, width),
    truncate(hints, width),
    "─".repeat(width),
    body,
    detail,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function renderSelfImproveReport(
  agentDir: string,
  options: SelfImproveCliOptions,
) {
  if (options.help) {
    printSelfImproveHelp();
    return "";
  }
  if (options.id && !options.json) {
    return renderSelfImproveDetail(
      querySelfImproveRecords(agentDir, { ...options, limit: 1 })[0],
    );
  }
  if (options.json) {
    return JSON.stringify(
      buildSelfImproveBackendReport(agentDir, options),
      null,
      2,
    );
  }
  if (
    options.once ||
    options.explicitLimit ||
    options.status ||
    options.trigger ||
    options.from ||
    options.to
  ) {
    const effectiveOptions = options.once
      ? { ...options, from: options.from || frontendFromIso() }
      : options;
    const records = querySelfImproveRecords(agentDir, effectiveOptions);
    const recent = records.slice(0, options.limit);
    return [
      `Rin self-improve history @ ${formatReportTime(nowIso())}`,
      "",
      summarize(records),
      "",
      "recent runs",
      renderRecentRuns(recent),
    ].join("\n");
  }
  return renderSelfImproveTui(agentDir, options, {}, { interactive: false });
}

async function runSelfImproveTui(
  agentDir: string,
  options: SelfImproveCliOptions,
) {
  const opened = await runInteractiveList({
    intervalMs: options.intervalMs,
    render: async (state) => ({
      content: renderSelfImproveTui(agentDir, options, state, {
        interactive: true,
      }),
      itemCount: tuiRecords(agentDir, options).length,
    }),
  });
  if (!opened)
    console.log(
      renderSelfImproveReport(agentDir, {
        ...options,
        once: true,
        watch: false,
      }),
    );
}

export async function runSelfImproveInternal(rawArgv: string[]) {
  const options = parseSelfImproveArgs(rawArgv);
  if (options.help) {
    printSelfImproveHelp();
    return;
  }
  const agentDir = process.env.RIN_DIR || "";
  if (!options.once && !options.json && !options.id)
    return await runSelfImproveTui(agentDir, options);
  console.log(renderSelfImproveReport(agentDir, options));
}

export async function runSelfImprove(parsed: ParsedArgs, rawArgv: string[]) {
  const options = parseSelfImproveArgs(rawArgv);
  if (options.help) {
    printSelfImproveHelp();
    return;
  }
  const context = createTargetExecutionContext(parsed);
  if (!context.isTargetUser) {
    if (!options.once && !options.json && !options.id) {
      context.exec([
        process.execPath,
        path.join(context.repoRoot, "dist", "app", "rin", "main.js"),
        "__self_improve_internal",
        ...extractSubcommandArgv(rawArgv, "self-improve"),
      ]);
      return;
    }
    const forwarded = captureInternalRinCommand(
      context,
      "__self_improve_internal",
      rawArgv,
      "self-improve",
    );
    process.stdout.write(forwarded);
    return;
  }
  if (!options.once && !options.json && !options.id)
    return await runSelfImproveTui(context.installDir, options);
  console.log(renderSelfImproveReport(context.installDir, options));
}
