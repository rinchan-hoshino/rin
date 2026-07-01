import fs from "node:fs";
import path from "node:path";

import { PhotonImage } from "@silvia-odwyer/photon-node";

import {
  queryTokenUsageAggregate,
  resolveTokenUsageRoot,
} from "../token-usage/store.js";
import { safeString } from "../text-utils.js";

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
  bucketHours: number;
  points: UsageTrendPoint[];
  total_tokens: number;
  peak_total_tokens: number;
};

export type UsageTrendOptions = {
  now?: Date | string | number;
  days?: number;
  bucketHours?: number;
};

type Rgba = readonly [number, number, number, number];

const DEFAULT_USAGE_TREND_DAYS = 7;
const DEFAULT_USAGE_TREND_BUCKET_HOURS = 3;
const USAGE_TREND_MAX_POINTS = 72;
const USAGE_TREND_CHART_KEEP = 24;
const USAGE_TREND_CHART_MAX_AGE_MS = 7 * 86_400_000;

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

function parseHourBucketMs(value: unknown) {
  const text = safeString(value).trim();
  if (!text) return Number.NaN;
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)
    ? `${text}:00.000Z`
    : text;
  return Date.parse(normalized);
}

function computeTrendRange(nowMs: number, days: number, bucketHours: number) {
  const bucketMs = bucketHours * 3_600_000;
  const windowStartMs = nowMs - days * 24 * 3_600_000;
  const startMs = Math.floor(windowStartMs / bucketMs) * bucketMs;
  const endMs = Math.floor(nowMs / bucketMs) * bucketMs;
  return {
    bucketMs,
    windowStartMs,
    startMs,
    endMs,
    pointCount: Math.max(1, Math.floor((endMs - startMs) / bucketMs) + 1),
  };
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

export function buildUsageTrendSeries(
  agentDir: string,
  options: UsageTrendOptions = {},
): UsageTrendSeries {
  const days = clampNumber(options.days, DEFAULT_USAGE_TREND_DAYS, 1, 31);
  let bucketHours = clampNumber(
    options.bucketHours,
    DEFAULT_USAGE_TREND_BUCKET_HOURS,
    1,
    24,
  );
  const nowMs = normalizeNowMs(options.now);
  let range = computeTrendRange(nowMs, days, bucketHours);
  while (range.pointCount > USAGE_TREND_MAX_POINTS && bucketHours < 24) {
    bucketHours += 1;
    range = computeTrendRange(nowMs, days, bucketHours);
  }
  const points = Array.from({ length: range.pointCount }, (_, index) =>
    emptyTrendPoint(toIso(range.startMs + index * range.bucketMs)),
  );

  const rows = queryTokenUsageAggregate({
    agentDir,
    from: toIso(range.windowStartMs),
    to: toIso(nowMs),
    groupBy: ["hour"],
    limit: Math.min(1_000, days * 24 + 24),
    orderBy: "hour",
    direction: "asc",
    includeZero: true,
  });
  for (const row of rows) {
    const hourMs = parseHourBucketMs(row.hour);
    if (!Number.isFinite(hourMs)) continue;
    const index = Math.floor((hourMs - range.startMs) / range.bucketMs);
    if (index < 0 || index >= points.length) continue;
    addTrendMetric(points[index], row);
  }

  const total = points.reduce((sum, point) => sum + point.total_tokens, 0);
  const peak = Math.max(0, ...points.map((point) => point.total_tokens));
  return {
    generatedAt: toIso(nowMs),
    start: toIso(range.startMs),
    end: toIso(range.endMs),
    days,
    bucketHours,
    points,
    total_tokens: total,
    peak_total_tokens: peak,
  };
}

function formatCompactCount(value: unknown) {
  const numeric = Math.max(0, Number(value || 0));
  if (numeric >= 1_000_000_000)
    return `${(numeric / 1_000_000_000).toFixed(1)}B`;
  if (numeric >= 1_000_000) return `${(numeric / 1_000_000).toFixed(1)}M`;
  if (numeric >= 1_000) return `${(numeric / 1_000).toFixed(1)}K`;
  return String(Math.round(numeric));
}

function formatTrendTick(value: unknown) {
  const timestamp = Date.parse(safeString(value).trim());
  if (!Number.isFinite(timestamp)) return "-- --:--";
  const date = new Date(timestamp);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:00`;
}

function lineChar(previousY: number, nextY: number) {
  if (nextY < previousY) return "╱";
  if (nextY > previousY) return "╲";
  return "─";
}

function renderTrendAxisLabels(series: UsageTrendSeries, width: number) {
  const left = formatTrendTick(series.start);
  const middle = formatTrendTick(
    series.points[Math.floor(series.points.length / 2)]?.timestamp,
  );
  const right = formatTrendTick(series.end);
  const chars = Array.from({ length: width }, () => " ");
  function place(label: string, start: number) {
    for (let index = 0; index < label.length; index += 1) {
      const target = start + index;
      if (target >= 0 && target < chars.length) chars[target] = label[index];
    }
  }
  place(left, 0);
  place(middle, Math.max(0, Math.floor((width - middle.length) / 2)));
  place(right, Math.max(0, width - right.length));
  return chars.join("").trimEnd();
}

export function renderUsageTrendTextChart(series: UsageTrendSeries) {
  const points = series.points;
  if (!points.length) return "7d usage trend\n  (no usage buckets)";
  const height = 8;
  const width = points.length;
  const max = Math.max(0, series.peak_total_tokens);
  const yFor = (value: number) => {
    if (max <= 0) return height - 1;
    return Math.max(
      0,
      Math.min(height - 1, Math.round((1 - value / max) * (height - 1))),
    );
  };
  const grid = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => " "),
  );
  let previousY = yFor(points[0].total_tokens);
  grid[previousY][0] = "•";
  for (let index = 1; index < points.length; index += 1) {
    const nextY = yFor(points[index].total_tokens);
    grid[nextY][index] = lineChar(previousY, nextY);
    previousY = nextY;
  }

  const labelWidth = Math.max(
    4,
    formatCompactCount(max).length,
    formatCompactCount(max / 2).length,
  );
  const rows = grid.map((row, index) => {
    let label = "";
    if (index === 0) label = formatCompactCount(max);
    else if (index === Math.floor((height - 1) / 2)) {
      label = formatCompactCount(max / 2);
    } else if (index === height - 1) label = "0";
    return `  ${label.padStart(labelWidth)} ┤${row.join("")}`;
  });

  return [
    `7d usage trend · ${series.bucketHours}h buckets · total ${formatCompactCount(series.total_tokens)} · peak ${formatCompactCount(max)}`,
    ...rows,
    `  ${"".padStart(labelWidth)} └${"─".repeat(width)}`,
    `  ${"".padStart(labelWidth + 2)} ${renderTrendAxisLabels(series, width)}`,
  ].join("\n");
}

const FONT_5X7: Record<string, string[]> = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "01010", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "01010", "00100", "00100", "00100", "01010", "10001"],
  Y: ["10001", "01010", "00100", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
  "(": ["00010", "00100", "01000", "01000", "01000", "00100", "00010"],
  ")": ["01000", "00100", "00010", "00010", "00010", "00100", "01000"],
};

function makeCanvas(width: number, height: number, color: Rgba) {
  const raw = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < raw.length; offset += 4) {
    raw[offset] = color[0];
    raw[offset + 1] = color[1];
    raw[offset + 2] = color[2];
    raw[offset + 3] = color[3];
  }
  return raw;
}

function blendPixel(
  raw: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  color: Rgba,
) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const offset = (Math.floor(y) * width + Math.floor(x)) * 4;
  const alpha = Math.max(0, Math.min(255, color[3])) / 255;
  const inverse = 1 - alpha;
  raw[offset] = Math.round(color[0] * alpha + raw[offset] * inverse);
  raw[offset + 1] = Math.round(color[1] * alpha + raw[offset + 1] * inverse);
  raw[offset + 2] = Math.round(color[2] * alpha + raw[offset + 2] * inverse);
  raw[offset + 3] = 255;
}

function drawRect(
  raw: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  rectWidth: number,
  rectHeight: number,
  color: Rgba,
) {
  for (let yy = 0; yy < rectHeight; yy += 1) {
    for (let xx = 0; xx < rectWidth; xx += 1) {
      blendPixel(raw, width, height, x + xx, y + yy, color);
    }
  }
}

function drawLine(
  raw: Uint8Array,
  width: number,
  height: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: Rgba,
  thickness = 1,
) {
  let currentX = Math.round(x1);
  let currentY = Math.round(y1);
  const targetX = Math.round(x2);
  const targetY = Math.round(y2);
  const dx = Math.abs(targetX - currentX);
  const sx = currentX < targetX ? 1 : -1;
  const dy = -Math.abs(targetY - currentY);
  const sy = currentY < targetY ? 1 : -1;
  let error = dx + dy;
  const radius = Math.max(0, Math.floor(thickness / 2));
  while (true) {
    drawRect(
      raw,
      width,
      height,
      currentX - radius,
      currentY - radius,
      Math.max(1, thickness),
      Math.max(1, thickness),
      color,
    );
    if (currentX === targetX && currentY === targetY) break;
    const e2 = 2 * error;
    if (e2 >= dy) {
      error += dy;
      currentX += sx;
    }
    if (e2 <= dx) {
      error += dx;
      currentY += sy;
    }
  }
}

function drawCircle(
  raw: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
  color: Rgba,
) {
  const r2 = radius * radius;
  for (let y = -radius; y <= radius; y += 1) {
    for (let x = -radius; x <= radius; x += 1) {
      if (x * x + y * y <= r2)
        blendPixel(raw, width, height, cx + x, cy + y, color);
    }
  }
}

function drawText(
  raw: Uint8Array,
  width: number,
  height: number,
  text: string,
  x: number,
  y: number,
  scale: number,
  color: Rgba,
) {
  let cursor = x;
  for (const char of text.toUpperCase()) {
    const glyph = FONT_5X7[char] || FONT_5X7[" "];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyph[row].length; column += 1) {
        if (glyph[row][column] === "1") {
          drawRect(
            raw,
            width,
            height,
            cursor + column * scale,
            y + row * scale,
            scale,
            scale,
            color,
          );
        }
      }
    }
    cursor += 6 * scale;
  }
}

function drawDottedVerticalLine(
  raw: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  lineHeight: number,
  color: Rgba,
) {
  for (let offset = 0; offset <= lineHeight; offset += 8) {
    drawLine(raw, width, height, x, y + offset, x, y + offset + 3, color, 1);
  }
}

function renderUsageTrendPng(series: UsageTrendSeries) {
  const width = 1000;
  const height = 520;
  const raw = makeCanvas(width, height, [9, 14, 29, 255]);
  const text = [226, 232, 240, 255] as const;
  const muted = [148, 163, 184, 255] as const;
  const grid = [51, 65, 85, 170] as const;
  const axis = [100, 116, 139, 255] as const;
  const accent = [255, 196, 87, 255] as const;
  const accentShadow = [255, 196, 87, 80] as const;
  const panel = [15, 23, 42, 255] as const;

  drawRect(raw, width, height, 20, 18, width - 40, height - 36, panel);
  drawText(raw, width, height, "RIN USAGE 7D", 44, 36, 4, text);
  drawText(
    raw,
    width,
    height,
    `${series.bucketHours}H BUCKETS  TOTAL ${formatCompactCount(series.total_tokens)}  PEAK ${formatCompactCount(series.peak_total_tokens)}`,
    46,
    78,
    2,
    muted,
  );

  const chartX = 88;
  const chartY = 120;
  const chartW = 850;
  const chartH = 300;
  const max = Math.max(0, series.peak_total_tokens);
  const valueY = (value: number) =>
    max <= 0 ? chartY + chartH : chartY + chartH - (value / max) * chartH;
  const pointX = (index: number) =>
    chartX +
    (series.points.length <= 1
      ? 0
      : (index / (series.points.length - 1)) * chartW);

  for (let index = 0; index <= 4; index += 1) {
    const y = chartY + (index / 4) * chartH;
    drawLine(raw, width, height, chartX, y, chartX + chartW, y, grid, 1);
    const label = formatCompactCount(max * (1 - index / 4));
    drawText(raw, width, height, label, 34, y - 7, 2, muted);
  }
  for (let index = 0; index < series.points.length; index += 8) {
    drawDottedVerticalLine(
      raw,
      width,
      height,
      pointX(index),
      chartY,
      chartH,
      grid,
    );
  }
  drawLine(
    raw,
    width,
    height,
    chartX,
    chartY,
    chartX,
    chartY + chartH,
    axis,
    2,
  );
  drawLine(
    raw,
    width,
    height,
    chartX,
    chartY + chartH,
    chartX + chartW,
    chartY + chartH,
    axis,
    2,
  );

  if (series.points.length) {
    let previousX = pointX(0);
    let previousY = valueY(series.points[0].total_tokens);
    for (let index = 1; index < series.points.length; index += 1) {
      const nextX = pointX(index);
      const nextY = valueY(series.points[index].total_tokens);
      drawLine(
        raw,
        width,
        height,
        previousX,
        previousY,
        nextX,
        nextY,
        accentShadow,
        7,
      );
      drawLine(
        raw,
        width,
        height,
        previousX,
        previousY,
        nextX,
        nextY,
        accent,
        3,
      );
      previousX = nextX;
      previousY = nextY;
    }
    for (let index = 0; index < series.points.length; index += 8) {
      drawCircle(
        raw,
        width,
        height,
        pointX(index),
        valueY(series.points[index].total_tokens),
        4,
        [255, 241, 179, 255],
      );
    }
    drawCircle(
      raw,
      width,
      height,
      pointX(series.points.length - 1),
      valueY(series.points[series.points.length - 1].total_tokens),
      4,
      [255, 241, 179, 255],
    );
  }

  drawText(
    raw,
    width,
    height,
    formatTrendTick(series.start),
    chartX,
    446,
    2,
    muted,
  );
  drawText(
    raw,
    width,
    height,
    formatTrendTick(series.end),
    chartX + chartW - 120,
    446,
    2,
    muted,
  );
  drawText(
    raw,
    width,
    height,
    "TOTAL TOKENS",
    chartX + chartW - 170,
    36,
    2,
    muted,
  );

  const image = new PhotonImage(raw, width, height);
  try {
    return Buffer.from(image.get_bytes());
  } finally {
    image.free();
  }
}

function safeChartTimestamp(value: string) {
  return safeString(value).replace(/[^0-9A-Za-z]+/g, "");
}

function pruneUsageTrendCharts(directory: string, nowMs: number) {
  let entries: Array<{ name: string; mtimeMs: number }> = [];
  try {
    entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) => entry.isFile() && /^usage-7d-.*\.png$/.test(entry.name),
      )
      .map((entry) => {
        const filePath = path.join(directory, entry.name);
        return { name: entry.name, mtimeMs: fs.statSync(filePath).mtimeMs };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
  } catch {
    return;
  }
  for (const [index, entry] of entries.entries()) {
    if (
      index >= USAGE_TREND_CHART_KEEP ||
      nowMs - entry.mtimeMs > USAGE_TREND_CHART_MAX_AGE_MS
    ) {
      try {
        fs.rmSync(path.join(directory, entry.name), { force: true });
      } catch {
        // Best-effort chart cache pruning must not break the usage command.
      }
    }
  }
}

export function writeUsageTrendChartImage(
  agentDir: string,
  options: UsageTrendOptions = {},
) {
  const series = buildUsageTrendSeries(agentDir, options);
  const chartsDir = path.join(resolveTokenUsageRoot(agentDir), "charts");
  fs.mkdirSync(chartsDir, { recursive: true });
  const filePath = path.join(
    chartsDir,
    `usage-7d-${safeChartTimestamp(series.generatedAt)}.png`,
  );
  fs.writeFileSync(filePath, renderUsageTrendPng(series));
  pruneUsageTrendCharts(chartsDir, normalizeNowMs(options.now));
  return filePath;
}
