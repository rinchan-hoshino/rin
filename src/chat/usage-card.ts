import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

import {
  formatUsdEquivalent,
  type UsageTrendSeries,
} from "./usage-trend.ts";

type Rgba = readonly [number, number, number, number];

export type CodexUsageCardOptions = {
  outputDir?: string;
  now?: () => Date;
  trend?: UsageTrendSeries;
  trendTitle?: string;
  trendSecondary?: string;
  trendFooter?: string;
};

const WIDTH = 1000;
const FONT_5X7: Record<string, readonly string[]> = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  $: ["00100", "01111", "10100", "01110", "00101", "11110", "00100"],
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
  "%": ["11001", "11010", "00100", "01000", "10110", "00110", "00000"],
  "@": ["01110", "10001", "10111", "10101", "10111", "10000", "01110"],
  _: ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
  "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
  ",": ["00000", "00000", "00000", "00000", "01100", "00100", "01000"],
  "(": ["00010", "00100", "01000", "01000", "01000", "00100", "00010"],
  ")": ["01000", "00100", "00010", "00010", "00010", "00100", "01000"],
};

function normalizeText(value: string): string {
  return value
    .replace(/[·•–—]/g, "-")
    .replace(/…/g, "...")
    .toUpperCase();
}

function truncate(value: string, maxChars: number): string {
  const normalized = normalizeText(value).trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function canvas(width: number, height: number, color: Rgba): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = color[0];
    pixels[offset + 1] = color[1];
    pixels[offset + 2] = color[2];
    pixels[offset + 3] = color[3];
  }
  return pixels;
}

function rect(
  pixels: Uint8Array,
  height: number,
  x: number,
  y: number,
  width: number,
  rectHeight: number,
  color: Rgba,
): void {
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(WIDTH, Math.ceil(x + width));
  const bottom = Math.min(height, Math.ceil(y + rectHeight));
  for (let yy = top; yy < bottom; yy += 1) {
    for (let xx = left; xx < right; xx += 1) {
      const offset = (yy * WIDTH + xx) * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = color[3];
    }
  }
}

function drawText(
  pixels: Uint8Array,
  height: number,
  value: string,
  x: number,
  y: number,
  scale: number,
  color: Rgba,
): void {
  let cursor = x;
  for (const character of normalizeText(value)) {
    const glyph = FONT_5X7[character] || FONT_5X7[" "];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyph[row].length; column += 1) {
        if (glyph[row][column] === "1") {
          rect(
            pixels,
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

function drawLine(
  pixels: Uint8Array,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: Rgba,
  thickness = 1,
): void {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const targetX = Math.round(x1);
  const targetY = Math.round(y1);
  const dx = Math.abs(targetX - x);
  const sx = x < targetX ? 1 : -1;
  const dy = -Math.abs(targetY - y);
  const sy = y < targetY ? 1 : -1;
  let error = dx + dy;
  while (true) {
    rect(pixels, height, x, y, thickness, thickness, color);
    if (x === targetX && y === targetY) break;
    const twice = error * 2;
    if (twice >= dy) {
      error += dy;
      x += sx;
    }
    if (twice <= dx) {
      error += dx;
      y += sy;
    }
  }
}

export function buildTrendYAxisTicks(maximum: number, divisions = 4): number[] {
  const peak = Math.max(0, Number(maximum) || 0);
  if (peak <= 0) return [0];
  return Array.from(
    { length: divisions + 1 },
    (_, index) => peak * (1 - index / divisions),
  );
}

function formatTrendDateLabel(value: string): string {
  const match = /^(?:\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[1]}/${match[2]}` : value;
}

export function buildUsageCostTrendView(trend: UsageTrendSeries) {
  const ticks = buildTrendYAxisTicks(trend.peak_cost);
  const dateLabels = trend.points.map((point) =>
    formatTrendDateLabel(point.timestamp),
  );
  const xAxisLabelCount = Math.min(7, dateLabels.length);
  const xAxisLabelStep = Math.max(
    1,
    Math.floor(dateLabels.length / xAxisLabelCount),
  );
  const xAxisLabelStart =
    dateLabels.length - 1 - xAxisLabelStep * (xAxisLabelCount - 1);
  const xAxisLabels = Array.from({ length: xAxisLabelCount }, (_, position) => {
    const index = xAxisLabelStart + position * xAxisLabelStep;
    return { index, label: dateLabels[index] };
  });
  return {
    title: `${trend.days}D USAGE VALUE - DAILY`,
    axisLabel: "USD/DAY",
    summary: trend.points.some(point => point.cost_total !== null) ? `TOTAL ${formatUsdEquivalent(trend.total_cost)}  PEAK ${formatUsdEquivalent(trend.peak_cost)}` : "TOTAL UNKNOWN  PEAK UNKNOWN",
    values: trend.points.map((point) => point.cost_total),
    dateLabels,
    xAxisLabels,
    ticks,
    tickLabels: ticks.map(formatUsdEquivalent),
  };
}

function windowLabel(window: CodexUsageWindow): string {
  if (window.name === "five_hour") return "5-HOUR";
  if (window.name === "weekly") return "WEEKLY";
  return window.name.replaceAll("_", "-");
}

function percentLabel(value: number | undefined): string {
  if (!Number.isFinite(value)) return "UNKNOWN";
  const rounded = Math.round(Number(value) * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}% LEFT`;
}

function resetLabel(value: string | undefined): string {
  if (!value) return "RESET UNKNOWN";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "RESET UNKNOWN";
  return `RESET ${date.toLocaleString()}`;
}

function progressColor(value: number | undefined): Rgba {
  if (!Number.isFinite(value)) return [100, 116, 139, 255];
  if (Number(value) >= 60) return [74, 222, 128, 255];
  if (Number(value) >= 25) return [250, 204, 21, 255];
  return [251, 113, 133, 255];
}

function crc32(input: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, data]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), 8 + data.length);
  return chunk;
}

function encodePng(pixels: Uint8Array, height: number): Buffer {
  const rows = Buffer.alloc(height * (WIDTH * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const target = y * (WIDTH * 4 + 1);
    rows[target] = 0;
    rows.set(pixels.subarray(y * WIDTH * 4, (y + 1) * WIDTH * 4), target + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function renderCodexUsageCardPng(
  status: CodexUsageStatus,
  options: Pick<
    CodexUsageCardOptions,
    "trend" | "trendTitle" | "trendSecondary" | "trendFooter"
  > = {},
): Buffer {
  const windows = status.windows.length
    ? status.windows
    : [{ name: "quota", percentLeft: undefined }];
  const creditsHeight = status.credits ? 58 : 0;
  const trendHeight = options.trend ? 330 : 0;
  const height = 196 + windows.length * 92 + creditsHeight + trendHeight + 64;
  const pixels = canvas(WIDTH, height, [9, 14, 29, 255]);
  const text: Rgba = [226, 232, 240, 255];
  const muted: Rgba = [148, 163, 184, 255];
  const panel: Rgba = [20, 29, 49, 255];
  const border: Rgba = [51, 65, 85, 255];
  const accent: Rgba = [56, 189, 248, 255];

  rect(pixels, height, 0, 0, WIDTH, 8, accent);
  drawText(pixels, height, "CHATGPT CODEX USAGE", 44, 34, 4, text);
  drawText(
    pixels,
    height,
    truncate(status.accountName || status.accountId, 70),
    46,
    76,
    2,
    muted,
  );
  if (status.plan) {
    drawText(
      pixels,
      height,
      truncate(`PLAN ${status.plan}`, 42),
      46,
      102,
      2,
      accent,
    );
  }
  rect(pixels, height, 44, 136, WIDTH - 88, 2, border);

  windows.forEach((window, index) => {
    const top = 160 + index * 92;
    const value = Number.isFinite(window.percentLeft)
      ? Math.max(0, Math.min(100, Number(window.percentLeft)))
      : undefined;
    const color = progressColor(value);
    rect(pixels, height, 44, top, WIDTH - 88, 72, panel);
    drawText(pixels, height, windowLabel(window), 64, top + 14, 2, text);
    drawText(pixels, height, percentLabel(value), 218, top + 14, 2, color);
    drawText(
      pixels,
      height,
      truncate(resetLabel(window.resetAt), 48),
      570,
      top + 14,
      2,
      muted,
    );
    rect(pixels, height, 64, top + 47, 852, 12, border);
    if (value !== undefined) {
      rect(
        pixels,
        height,
        64,
        top + 47,
        Math.round(852 * (value / 100)),
        12,
        color,
      );
    }
  });

  let footerTop = 160 + windows.length * 92;
  if (status.credits) {
    drawText(
      pixels,
      height,
      truncate(`CREDITS ${status.credits}`, 70),
      48,
      footerTop + 16,
      2,
      text,
    );
    footerTop += creditsHeight;
  }
  const trend = options.trend;
  if (trend) {
    const panelX = 40;
    const panelY = footerTop;
    const panelWidth = WIDTH - 80;
    const panelHeight = 294;
    rect(pixels, height, panelX, panelY, panelWidth, panelHeight, panel);
    rect(pixels, height, panelX, panelY, panelWidth, 2, border);
    rect(
      pixels,
      height,
      panelX,
      panelY + panelHeight - 2,
      panelWidth,
      2,
      border,
    );
    const costView = buildUsageCostTrendView(trend);
    drawText(
      pixels,
      height,
      options.trendTitle || costView.title,
      panelX + 20,
      panelY + 18,
      2,
      accent,
    );
    drawText(
      pixels,
      height,
      `${costView.summary}${options.trendSecondary ? `  ${options.trendSecondary}` : ""}`,
      panelX + 20,
      panelY + 48,
      2,
      muted,
    );
    const chartX = panelX + 64;
    const chartY = panelY + 84;
    const chartWidth = panelWidth - 94;
    const chartHeight = 172;
    const maximum = Math.max(0, trend.peak_cost);
    const yTicks = costView.ticks;
    for (let index = 0; index <= 4; index += 1) {
      const y = chartY + (index / 4) * chartHeight;
      drawLine(pixels, height, chartX, y, chartX + chartWidth, y, border);
      if (maximum > 0 || index === 4) {
        const tick = maximum > 0 ? yTicks[index] : 0;
        const label = formatUsdEquivalent(tick);
        drawText(
          pixels,
          height,
          label,
          chartX - 8 - label.length * 6,
          y - 3,
          1,
          muted,
        );
      }
    }
    drawText(pixels, height, costView.axisLabel, chartX, chartY - 14, 1, muted);
    drawLine(
      pixels,
      height,
      chartX,
      chartY,
      chartX,
      chartY + chartHeight,
      muted,
    );
    drawLine(
      pixels,
      height,
      chartX,
      chartY + chartHeight,
      chartX + chartWidth,
      chartY + chartHeight,
      muted,
    );
    const points = trend.points;
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      if (previous.cost_total === null || current.cost_total === null) continue;
      const denominator = Math.max(1, points.length - 1);
      const previousX = chartX + ((index - 1) / denominator) * chartWidth;
      const currentX = chartX + (index / denominator) * chartWidth;
      const previousY =
        maximum <= 0
          ? chartY + chartHeight
          : chartY +
            chartHeight -
            (previous.cost_total / maximum) * chartHeight;
      const currentY =
        maximum <= 0
          ? chartY + chartHeight
          : chartY + chartHeight - (current.cost_total / maximum) * chartHeight;
      drawLine(
        pixels,
        height,
        previousX,
        previousY,
        currentX,
        currentY,
        accent,
        3,
      );
    }
    // Isolated recorded days remain visible; missing days never become zero.
    points.forEach((point, index) => {
      if (point.cost_total === null || (points[index - 1]?.cost_total != null && points[index + 1]?.cost_total != null)) return;
      const x = chartX + index / Math.max(1, points.length - 1) * chartWidth;
      const y = chartY + chartHeight - (maximum > 0 ? point.cost_total / maximum * chartHeight : 0);
      rect(pixels, height, x - 2, y - 2, 5, 5, accent);
    });
    const labelDenominator = Math.max(1, costView.values.length - 1);
    for (const { index, label } of costView.xAxisLabels) {
      const centerX = chartX + (index / labelDenominator) * chartWidth;
      const labelWidth = label.length * 12;
      const x = Math.max(
        chartX,
        Math.min(chartX + chartWidth - labelWidth, centerX - labelWidth / 2),
      );
      drawText(pixels, height, label, x, chartY + chartHeight + 14, 2, muted);
    }
    footerTop += trendHeight;
  }

  rect(pixels, height, 44, footerTop + 12, WIDTH - 88, 2, border);
  drawText(
    pixels,
    height,
    options.trendFooter || (options.trend ? "CODEX QUOTA + USD-EQUIV HISTORY" : "CODEX QUOTA - USD-EQUIV HISTORY UNKNOWN"),
    46,
    footerTop + 32,
    2,
    muted,
  );
  return encodePng(pixels, height);
}

function defaultOutputDir(): string {
  const agentDir =
    process.env.RIN_DIR ||
    process.env.PI_CODING_AGENT_DIR ||
    path.join(os.homedir(), ".rin");
  return path.join(agentDir, "data", "extensions", "codex-usage", "output");
}

async function pruneOutputFiles(
  outputDir: string,
  keepPath: string,
): Promise<void> {
  const names = (await readdir(outputDir)).filter((name) =>
    name.endsWith(".png"),
  );
  const stale = names
    .map((name) => path.join(outputDir, name))
    .filter((filePath) => filePath !== keepPath)
    .sort()
    .slice(0, Math.max(0, names.length - 8));
  await Promise.all(stale.map((filePath) => rm(filePath, { force: true })));
}

export async function writeCodexUsageCard(
  status: CodexUsageStatus,
  options: CodexUsageCardOptions = {},
): Promise<string> {
  const now = options.now?.() || new Date();
  const outputDir = options.outputDir || defaultOutputDir();
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(
    outputDir,
    `codex-usage-${now.toISOString().replace(/[^0-9A-Za-z]/g, "")}.png`,
  );
  await writeFile(filePath, renderCodexUsageCardPng(status, options), {
    mode: 0o600,
  });
  await pruneOutputFiles(outputDir, filePath);
  return filePath;
}
