import fs from "node:fs";

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

export type SelfImproveCliOptions = {
  from?: string;
  to?: string;
  limit: number;
  explicitLimit: boolean;
  status?: string;
  trigger?: string;
  id?: string;
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

function printSelfImproveHelp() {
  console.log(
    [
      "rin self-improve [options]",
      "",
      "Frontend view:",
      "  Shows all self-improve outcomes from the past 1 day.",
      "",
      "Options:",
      "  --id <id>           show details for one self-improve run",
      "  --json              backend view with complete filtered records and stats",
      "  --from <time>       backend start time (ISO, YYYY-MM-DD, 24h, 7d, 30m)",
      "  --to <time>         backend end time (ISO, YYYY-MM-DD, 24h, 7d, 30m)",
      "  --limit <n>         backend run limit (default 20)",
      "  --status <status>   backend filter: completed or failed",
      "  --trigger <text>    backend substring filter for trigger",
      "  --help              show this help",
      "",
      "Examples:",
      "  rin self-improve",
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
    json: false,
    help: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--json") {
      result.json = true;
      continue;
    }
    if (arg === "--id") {
      result.id = readArg(args, ++i);
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

function changedFileSummary(record: MaintenanceHistoryRecord) {
  const files = Array.isArray(record.changedFiles) ? record.changedFiles : [];
  if (!files.length) return "-";
  const visible = files
    .slice(0, 4)
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

function isBackendSelfImproveRequest(options: SelfImproveCliOptions) {
  return Boolean(
    options.json ||
    options.from ||
    options.to ||
    options.status ||
    options.trigger ||
    options.explicitLimit,
  );
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
  if (isBackendSelfImproveRequest(options)) {
    const records = querySelfImproveRecords(agentDir, options);
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
  const records = querySelfImproveRecords(agentDir, {
    ...options,
    from: frontendFromIso(),
  });
  return [
    `Rin self-improve outcomes @ ${formatReportTime(nowIso())}`,
    `window: past 1d · ${records.length} runs`,
    "",
    renderSelfImproveList(records),
    "",
    "Use `rin self-improve --id <id>` to view details, or `rin self-improve --json` for the backend record set.",
  ].join("\n");
}

export async function runSelfImproveInternal(rawArgv: string[]) {
  const options = parseSelfImproveArgs(rawArgv);
  if (options.help) {
    printSelfImproveHelp();
    return;
  }
  console.log(renderSelfImproveReport(process.env.RIN_DIR || "", options));
}

export async function runSelfImprove(parsed: ParsedArgs, rawArgv: string[]) {
  const options = parseSelfImproveArgs(rawArgv);
  if (options.help) {
    printSelfImproveHelp();
    return;
  }
  const context = createTargetExecutionContext(parsed);
  if (!context.isTargetUser) {
    const forwarded = captureInternalRinCommand(
      context,
      "__self_improve_internal",
      rawArgv,
      "self-improve",
    );
    process.stdout.write(forwarded);
    return;
  }
  console.log(renderSelfImproveReport(context.installDir, options));
}
