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
  status?: string;
  trigger?: string;
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
      "rin self [options]",
      "",
      "Options:",
      "  --from <time>       start time (ISO, YYYY-MM-DD, 24h, 7d, 30m)",
      "  --to <time>         end time (ISO, YYYY-MM-DD, 24h, 7d, 30m)",
      "  --limit <n>         recent run limit (default 20)",
      "  --status <status>   completed or failed",
      "  --trigger <text>    substring filter for trigger",
      "  --help              show this help",
      "",
      "Examples:",
      "  rin self",
      "  rin self --from 7d --limit 50",
      "  rin self --status failed --from 30d",
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
  const args = extractSubcommandArgv(argv, "self");
  const result: SelfImproveCliOptions = { limit: 20, help: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
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

export function renderSelfImproveReport(
  agentDir: string,
  options: SelfImproveCliOptions,
) {
  if (options.help) {
    printSelfImproveHelp();
    return "";
  }
  const records = readHistory(agentDir)
    .filter((record) => inRange(record, options))
    .sort((a, b) => recordTimestamp(b) - recordTimestamp(a));
  const recent = records.slice(0, options.limit);
  return [
    `Rin self-improve distillation @ ${formatReportTime(nowIso())}`,
    "",
    summarize(records),
    "",
    "recent runs",
    renderRecentRuns(recent),
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
      "self",
    );
    process.stdout.write(forwarded);
    return;
  }
  console.log(renderSelfImproveReport(context.installDir, options));
}
