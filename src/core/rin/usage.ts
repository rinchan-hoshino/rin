import {
  captureInternalRinCommand,
  createTargetExecutionContext,
  extractSubcommandArgv,
  ParsedArgs,
  safeString,
} from "./shared.js";
import type { TokenUsageQueryOptions } from "../token-usage/store.js";
import {
  formatProviderModelLabel,
  getTokenUsageOverview,
  listTokenUsageDimensions,
  queryTokenUsageAggregate,
  queryTokenUsageEvents,
} from "../token-usage/store.js";

export type UsageCliOptions = {
  from?: string;
  to?: string;
  groupBy: string[];
  filters: Array<{ key: string; value: string }>;
  limit: number;
  orderBy: string;
  direction: "asc" | "desc";
  events: boolean;
  includeZero: boolean;
  dimensions: boolean;
  help: boolean;
};

type UsageScope = Pick<
  TokenUsageQueryOptions,
  "agentDir" | "from" | "to" | "filters"
>;

type UsageAggregateSection = {
  title: string;
  groupBy: string[];
  limit: number;
};

const DASHBOARD_AGGREGATE_SECTIONS: UsageAggregateSection[] = [
  { title: "top models", groupBy: ["provider_model"], limit: 8 },
  { title: "top sources", groupBy: ["source"], limit: 8 },
  { title: "top sessions", groupBy: ["session_name", "session_id"], limit: 8 },
  { title: "top capabilities", groupBy: ["capability"], limit: 10 },
];

function printUsageHelp() {
  console.log(
    [
      "rin usage [options]",
      "",
      "Options:",
      "  --from <time>         start time (ISO, YYYY-MM-DD, 24h, 7d, 30m)",
      "  --to <time>           end time (ISO, YYYY-MM-DD, 24h, 7d, 30m)",
      "  --group-by <dims>     comma-separated dimensions",
      "  --filter <k=v>        equality filter, repeatable",
      "  --limit <n>           row limit (default 20)",
      "  --order-by <metric>   total_tokens, cost_total, rows, input_tokens...",
      "  --direction <dir>     asc or desc",
      "  --events              show raw events instead of aggregates",
      "  --include-zero        include zero-token rows in aggregates",
      "  --dimensions          list supported dimensions",
      "  --help                show this help",
      "",
      "Examples:",
      "  rin usage",
      "  rin usage --group-by provider_model,capability --from 7d",
      "  rin usage --group-by session_id,event_type --filter source=extension",
      "  rin usage --events --limit 50 --filter session_id=abc123",
    ].join("\n"),
  );
}

function parsePositiveInt(value: string, fallback: number) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.round(num);
}

function readUsageArg(args: string[], index: number): string {
  return safeString(args[index]).trim();
}

function parseGroupByArg(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseFilterArg(raw: string) {
  const eq = raw.indexOf("=");
  if (eq <= 0 || eq >= raw.length - 1) {
    throw new Error(`invalid_filter:${raw}`);
  }
  return {
    key: raw.slice(0, eq).trim(),
    value: raw.slice(eq + 1).trim(),
  };
}

function normalizeDirectionArg(value: string): "asc" | "desc" {
  return value.toLowerCase() === "asc" ? "asc" : "desc";
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
    const now = Date.now();
    const deltaMs =
      unit === "m"
        ? amount * 60_000
        : unit === "h"
          ? amount * 3_600_000
          : unit === "d"
            ? amount * 86_400_000
            : amount * 7 * 86_400_000;
    return new Date(now - deltaMs).toISOString();
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

export function parseUsageArgs(argv: string[]): UsageCliOptions {
  const args = extractSubcommandArgv(argv, "usage");
  const result: UsageCliOptions = {
    groupBy: [],
    filters: [],
    limit: 20,
    orderBy: "total_tokens",
    direction: "desc",
    events: false,
    includeZero: false,
    dimensions: false,
    help: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--events") {
      result.events = true;
      continue;
    }
    if (arg === "--include-zero") {
      result.includeZero = true;
      continue;
    }
    if (arg === "--dimensions") {
      result.dimensions = true;
      continue;
    }
    if (arg === "--from") {
      result.from = normalizeTimeArg(readUsageArg(args, ++i), "start");
      continue;
    }
    if (arg === "--to") {
      result.to = normalizeTimeArg(readUsageArg(args, ++i), "end");
      continue;
    }
    if (arg === "--group-by") {
      result.groupBy = parseGroupByArg(readUsageArg(args, ++i));
      continue;
    }
    if (arg === "--filter") {
      result.filters.push(parseFilterArg(readUsageArg(args, ++i)));
      continue;
    }
    if (arg === "--limit") {
      result.limit = parsePositiveInt(readUsageArg(args, ++i), result.limit);
      continue;
    }
    if (arg === "--order-by") {
      result.orderBy = readUsageArg(args, ++i) || result.orderBy;
      continue;
    }
    if (arg === "--direction") {
      result.direction = normalizeDirectionArg(readUsageArg(args, ++i));
      continue;
    }
    throw new Error(`unknown_usage_arg:${arg}`);
  }
  return result;
}

function formatInt(value: unknown) {
  return Math.round(Number(value || 0)).toLocaleString("en-US");
}

function formatCost(value: unknown) {
  return Number(value || 0).toFixed(4);
}

function pad(value: string, width: number) {
  if (value.length >= width) return value;
  return value + " ".repeat(width - value.length);
}

function truncate(value: string, width: number) {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

function renderTable(rows: Array<Record<string, unknown>>, columns: string[]) {
  if (!rows.length) return "(no rows)";
  const widths = new Map<string, number>();
  for (const column of columns) {
    widths.set(column, column.length);
  }
  for (const row of rows) {
    for (const column of columns) {
      const value = safeString(row[column] ?? "");
      widths.set(
        column,
        Math.min(48, Math.max(widths.get(column) || 0, value.length)),
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
          truncate(safeString(row[column] ?? ""), widths.get(column) || 0),
          widths.get(column) || 0,
        ),
      )
      .join("  "),
  );
  return [header, divider, ...body].join("\n");
}

function summarizeOverview(overview: any) {
  const lines = [
    `events=${formatInt(overview?.total_events)}`,
    `tokenEvents=${formatInt(overview?.token_events)}`,
    `sessions=${formatInt(overview?.session_count)}`,
    `models=${formatInt(overview?.model_count)}`,
    `tokens=${formatInt(overview?.total_tokens)} (in=${formatInt(overview?.input_tokens)}, out=${formatInt(overview?.output_tokens)}, cacheRead=${formatInt(overview?.cache_read_tokens)}, cacheWrite=${formatInt(overview?.cache_write_tokens)})`,
    `cost=$${formatCost(overview?.cost_total)}`,
  ];
  if (
    safeString(overview?.first_timestamp).trim() ||
    safeString(overview?.last_timestamp).trim()
  ) {
    lines.push(
      `range=${safeString(overview?.first_timestamp).trim() || "-"} .. ${safeString(overview?.last_timestamp).trim() || "-"}`,
    );
  }
  return lines.join("\n");
}

function renderAggregateTable(
  title: string,
  groupBy: string[],
  rows: Array<Record<string, unknown>>,
) {
  const metrics = [
    "rows",
    "token_events",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "total_tokens",
    "cost_total",
  ];
  const formatted = rows.map((row) => {
    const next: Record<string, unknown> = {};
    for (const key of groupBy) next[key] = row[key];
    next.rows = formatInt(row.rows);
    next.token_events = formatInt(row.token_events);
    next.input_tokens = formatInt(row.input_tokens);
    next.output_tokens = formatInt(row.output_tokens);
    next.cache_read_tokens = formatInt(row.cache_read_tokens);
    next.cache_write_tokens = formatInt(row.cache_write_tokens);
    next.total_tokens = formatInt(row.total_tokens);
    next.cost_total = `$${formatCost(row.cost_total)}`;
    return next;
  });
  return `${title}\n${renderTable(formatted, [...groupBy, ...metrics])}`;
}

function renderEventTable(rows: Array<Record<string, unknown>>) {
  const formatted = rows.map((row) => ({
    timestamp: safeString(row.timestamp)
      .replace("T", " ")
      .replace(".000Z", "Z"),
    session_id: row.session_id,
    source: row.source,
    event_type: row.event_type,
    provider_model: formatProviderModelLabel(row.provider, row.model),
    capability: row.capability_key,
    tool_name: row.tool_name,
    message_role: row.message_role,
    total_tokens: formatInt(row.total_tokens),
    cost_total: `$${formatCost(row.cost_total)}`,
    stop_reason: row.stop_reason,
  }));
  return renderTable(formatted, [
    "timestamp",
    "session_id",
    "source",
    "event_type",
    "provider_model",
    "capability",
    "tool_name",
    "message_role",
    "total_tokens",
    "cost_total",
    "stop_reason",
  ]);
}

function buildUsageScope(
  agentDir: string,
  options: UsageCliOptions,
): UsageScope {
  return {
    agentDir,
    from: options.from,
    to: options.to,
    filters: options.filters,
  };
}

function queryDashboardAggregate(
  scope: UsageScope,
  section: UsageAggregateSection,
): Array<Record<string, unknown>> {
  return queryTokenUsageAggregate({
    ...scope,
    groupBy: section.groupBy,
    limit: section.limit,
  });
}

function queryRecentMessageEvents(
  scope: UsageScope,
  limit: number,
): Array<Record<string, unknown>> {
  return queryTokenUsageEvents({
    ...scope,
    filters: [...scope.filters, { key: "event_type", value: "message_end" }],
    limit,
  }).filter((row) => Number(row.total_tokens || 0) > 0);
}

export function renderUsageReport(
  agentDir: string,
  options: UsageCliOptions,
): string {
  if (options.help) {
    printUsageHelp();
    return "";
  }
  if (options.dimensions) {
    return [
      "supported dimensions:",
      ...listTokenUsageDimensions().map((item) => `- ${item}`),
    ].join("\n");
  }
  const scope = buildUsageScope(agentDir, options);
  if (options.events) {
    return renderEventTable(
      queryTokenUsageEvents({ ...scope, limit: options.limit }),
    );
  }
  if (options.groupBy.length > 0) {
    const rows = queryTokenUsageAggregate({
      ...scope,
      groupBy: options.groupBy,
      limit: options.limit,
      orderBy: options.orderBy,
      direction: options.direction,
      includeZero: options.includeZero,
    });
    return renderAggregateTable("aggregate", options.groupBy, rows);
  }

  const overview = getTokenUsageOverview(scope);
  const aggregateSections = DASHBOARD_AGGREGATE_SECTIONS.map((section) =>
    renderAggregateTable(
      section.title,
      section.groupBy,
      queryDashboardAggregate(scope, section),
    ),
  );
  const recent = queryRecentMessageEvents(scope, 10);

  return [
    "token usage dashboard",
    summarizeOverview(overview),
    "",
    ...aggregateSections.flatMap((section) => [section, ""]),
    "recent token events",
    renderEventTable(recent),
  ].join("\n");
}

export async function runUsageInternal(rawArgv: string[]) {
  const options = parseUsageArgs(rawArgv);
  if (options.help) {
    printUsageHelp();
    return;
  }
  console.log(
    renderUsageReport(
      process.env.RIN_DIR || process.env.PI_CODING_AGENT_DIR || "",
      options,
    ),
  );
}

export async function runUsage(parsed: ParsedArgs, rawArgv: string[]) {
  const options = parseUsageArgs(rawArgv);
  if (options.help) {
    printUsageHelp();
    return;
  }
  const context = createTargetExecutionContext(parsed);
  if (!context.isTargetUser) {
    const forwarded = captureInternalRinCommand(
      context,
      "__usage_internal",
      rawArgv,
      "usage",
    );
    process.stdout.write(forwarded);
    return;
  }
  console.log(renderUsageReport(context.installDir, options));
}
