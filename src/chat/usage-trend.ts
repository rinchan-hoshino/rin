function safeString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export type UsageTrendPoint = {
  timestamp: string;
  rows: number;
  token_events: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_total: number;
  context_tokens: number;
};

export type UsageTrendSeries = {
  generatedAt: string;
  start: string;
  end: string;
  days: number;
  bucket: "day";
  points: UsageTrendPoint[];
  total_tokens: number;
  peak_total_tokens: number;
  total_cost: number;
  peak_cost: number;
};

export type UsageTrendOptions = {
  now?: Date | string | number;
  days?: number;
};

const DEFAULT_USAGE_TREND_DAYS = 14;

function clampNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

function normalizeNowMs(value: UsageTrendOptions["now"]) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const text = safeString(value).trim();
  if (text) {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function toIso(ms: number) {
  return new Date(ms).toISOString();
}

function localDateKey(value: Date): string {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0"),
  ].join("-");
}

function buildLocalDateKeys(nowMs: number, days: number): string[] {
  const current = new Date(nowMs);
  current.setHours(12, 0, 0, 0);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(current);
    date.setDate(current.getDate() - (days - index - 1));
    return localDateKey(date);
  });
}

function emptyTrendPoint(timestamp: string): UsageTrendPoint {
  return {
    timestamp,
    rows: 0,
    token_events: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: 0,
    cost_total: 0,
    context_tokens: 0,
  };
}

function addTrendMetric(point: UsageTrendPoint, row: Record<string, unknown>) {
  point.rows += Number(row.rows || 0);
  point.token_events += Number(row.token_events || 0);
  point.input_tokens += Number(row.input_tokens || 0);
  point.output_tokens += Number(row.output_tokens || 0);
  point.cache_read_tokens += Number(row.cache_read_tokens || 0);
  point.cache_write_tokens += Number(row.cache_write_tokens || 0);
  point.total_tokens += Number(row.total_tokens || 0);
  point.cost_total += Number(row.cost_total || 0);
  point.context_tokens = Math.max(
    point.context_tokens,
    Number(row.context_tokens || 0),
  );
}

export function formatCompactCount(value: unknown) {
  const numeric = Math.max(0, Number(value || 0));
  if (numeric >= 1_000_000_000)
    return `${(numeric / 1_000_000_000).toFixed(1)}B`;
  if (numeric >= 1_000_000) return `${(numeric / 1_000_000).toFixed(1)}M`;
  if (numeric >= 1_000) return `${(numeric / 1_000).toFixed(1)}K`;
  return String(Math.round(numeric));
}

export function formatUsdEquivalent(value: unknown) {
  const numeric = Math.max(0, Number(value || 0));
  if (numeric >= 1_000_000) return `$${(numeric / 1_000_000).toFixed(1)}M`;
  if (numeric >= 1_000) return `$${(numeric / 1_000).toFixed(1)}K`;
  return `$${numeric.toFixed(2)}`;
}
