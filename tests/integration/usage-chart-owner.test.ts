import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const chart = await importBuiltModule<
  typeof import("../../src/core/rin/usage-chart.js")
>("dist/core/rin/usage-chart.js");
const store = await importBuiltModule<
  typeof import("../../src/core/token-usage/store.js")
>("dist/core/token-usage/store.js");

async function withAgentDir(run: (agentDir: string) => Promise<void>) {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chart-owner-"));
  try {
    await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

function point(timestamp: string, total_tokens: number) {
  return {
    timestamp,
    rows: 1,
    token_events: 1,
    input_tokens: total_tokens,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens,
    cost_total: 0,
    context_tokens: total_tokens,
  };
}

test("usage trend builds bounded buckets from real telemetry", async () => {
  await withAgentDir(async (agentDir) => {
    for (const [id, timestamp, totalTokens, contextTokens] of [
      ["before", "2026-07-07T00:00:00.000Z", 99, 1],
      ["first", "2026-07-15T21:10:00.000Z", 10, 20],
      ["second", "2026-07-15T22:50:00.000Z", 30, 50],
      ["last", "2026-07-16T00:05:00.000Z", 5, 10],
    ] as const) {
      store.appendTokenTelemetryEvent(
        {
          id,
          timestamp,
          sessionId: "owner",
          eventType: "message_end",
          totalTokens,
          inputTokens: totalTokens,
          contextTokens,
        },
        agentDir,
      );
    }

    const series = chart.buildUsageTrendSeries(agentDir, {
      now: new Date("2026-07-16T00:30:00.000Z"),
      days: 1,
      bucketHours: 1,
    });
    assert.equal(series.days, 1);
    assert.equal(series.bucketHours, 1);
    assert.equal(series.total_tokens, 45);
    assert.equal(series.peak_total_tokens, 30);
    assert.equal(
      series.points.find((entry) => entry.total_tokens === 30)?.context_tokens,
      50,
    );

    const clamped = chart.buildUsageTrendSeries(agentDir, {
      now: "invalid",
      days: 100,
      bucketHours: 0,
    });
    assert.equal(clamped.days, 31);
    assert.ok(clamped.bucketHours > 1);
    assert.ok(clamped.points.length <= 72);

    const numeric = chart.buildUsageTrendSeries(agentDir, {
      now: Date.parse("2026-07-16T00:30:00.000Z"),
      days: Number.NaN,
      bucketHours: Number.POSITIVE_INFINITY,
    });
    assert.equal(numeric.days, 7);
    assert.equal(numeric.bucketHours, 3);
  });
});

test("usage trend text chart renders empty, flat, rising, and falling series", () => {
  assert.equal(
    chart.renderUsageTrendTextChart({
      generatedAt: "2026-07-16T00:00:00.000Z",
      start: "bad",
      end: "bad",
      days: 7,
      bucketHours: 3,
      points: [],
      total_tokens: 0,
      peak_total_tokens: 0,
    }),
    "7d usage trend\n  (no usage buckets)",
  );

  const points = [
    point("2026-07-15T21:00:00.000Z", 0),
    point("2026-07-15T22:00:00.000Z", 1_500),
    point("2026-07-15T23:00:00.000Z", 1_500),
    point("invalid", 500),
  ];
  const rendered = chart.renderUsageTrendTextChart({
    generatedAt: "2026-07-16T00:00:00.000Z",
    start: points[0].timestamp,
    end: points.at(-1)!.timestamp,
    days: 7,
    bucketHours: 1,
    points,
    total_tokens: 3_500,
    peak_total_tokens: 1_500,
  });
  assert.match(rendered, /total 3\.5K/);
  assert.match(rendered, /╱|╲|─/);
  assert.match(rendered, /-- -/);

  const huge = chart.renderUsageTrendTextChart({
    generatedAt: "2026-07-16T00:00:00.000Z",
    start: points[0].timestamp,
    end: points[0].timestamp,
    days: 7,
    bucketHours: 24,
    points: [point(points[0].timestamp, 1_200_000_000)],
    total_tokens: 1_200_000_000,
    peak_total_tokens: 1_200_000_000,
  });
  assert.match(huge, /1\.2B/);
});

test("usage chart image writes a PNG and prunes stale chart artifacts", async () => {
  await withAgentDir(async (agentDir) => {
    store.appendTokenTelemetryEvent(
      {
        id: "image-point",
        timestamp: "2026-07-16T00:00:00.000Z",
        sessionId: "owner",
        eventType: "message_end",
        totalTokens: 2_000_000,
        inputTokens: 1_000_000,
      },
      agentDir,
    );
    const chartsDir = path.join(
      store.resolveTokenUsageRoot(agentDir),
      "charts",
    );
    await fs.mkdir(chartsDir, { recursive: true });
    for (let index = 0; index < 27; index += 1) {
      const filePath = path.join(chartsDir, `usage-7d-old-${index}.png`);
      await fs.writeFile(filePath, "old");
      await fs.utimes(filePath, new Date(0), new Date(0));
    }
    await fs.writeFile(path.join(chartsDir, "unrelated.txt"), "keep");

    const filePath = chart.writeUsageTrendChartImage(agentDir, {
      now: "2026-07-16T00:30:00.000Z",
      days: 1,
      bucketHours: 1,
      quotaLines: [
        "Weekly 80% LEFT RESET 2d",
        "Daily 35% LEFT RESET 4h",
        "Burst 10% LEFT RESET 5m",
        "free form quota note",
        "",
        ...Array.from({ length: 12 }, (_, index) => `extra ${index}`),
      ],
    });
    const bytes = await fs.readFile(filePath);
    assert.deepEqual(
      [...bytes.subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
    const names = await fs.readdir(chartsDir);
    assert.ok(names.includes("unrelated.txt"));
    assert.ok(
      names.filter((name) => /^usage-7d-.*\.png$/.test(name)).length <= 24,
    );
  });
});
