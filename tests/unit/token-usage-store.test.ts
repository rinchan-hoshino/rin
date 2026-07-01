import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const store = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "token-usage", "store.js"))
    .href
);
const usageCli = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "usage.js")).href
);
const tokenUsageModule = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "token-usage", "index.js"))
    .href
);

async function withTempRoot(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-token-usage-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("token usage store aggregates by session and capability", async () => {
  await withTempRoot(async (root) => {
    store.appendTokenTelemetryEvent(
      {
        id: "evt-1",
        timestamp: "2026-04-10T10:00:00.000Z",
        sessionId: "s1",
        sessionName: "chat-1",
        eventType: "message_end",
        messageRole: "assistant",
        provider: "openai-codex",
        model: "gpt-5.4",
        capabilityKind: "assistant_tool_call",
        capabilityKey: "tool:read",
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        costTotal: 0.12,
      },
      root,
    );
    store.appendTokenTelemetryEvent(
      {
        id: "evt-2",
        timestamp: "2026-04-10T10:05:00.000Z",
        sessionId: "s2",
        sessionName: "chat-2",
        eventType: "message_end",
        messageRole: "assistant",
        provider: "openai-codex",
        model: "gpt-5.4-mini",
        capabilityKind: "assistant_text",
        capabilityKey: "assistant:text",
        inputTokens: 40,
        outputTokens: 10,
        totalTokens: 50,
        costTotal: 0.05,
      },
      root,
    );
    store.appendTokenTelemetryEvent(
      {
        id: "evt-3",
        timestamp: "2026-04-10T10:06:00.000Z",
        sessionId: "s2",
        eventType: "tool_execution_end",
        toolName: "read",
        capabilityKind: "tool_execution",
        capabilityKey: "tool:read",
      },
      root,
    );

    const bySession = store.queryTokenUsageAggregate({
      agentDir: root,
      groupBy: ["session_id"],
      limit: 10,
    });
    assert.equal(bySession.length, 2);
    assert.equal(bySession[0].session_id, "s1");
    assert.equal(bySession[0].total_tokens, 120);
    assert.equal(bySession[1].session_id, "s2");
    assert.equal(bySession[1].total_tokens, 50);

    const byCapability = store.queryTokenUsageAggregate({
      agentDir: root,
      groupBy: ["capability"],
      limit: 10,
      includeZero: true,
    });
    assert.equal(byCapability[0].capability, "tool:read");
    assert.equal(byCapability[0].total_tokens, 120);
    assert.equal(byCapability[0].rows, 2);

    const overview = store.getTokenUsageOverview({ agentDir: root });
    assert.equal(overview.total_events, 3);
    assert.equal(overview.token_events, 2);
    assert.equal(overview.total_tokens, 170);
    assert.equal(overview.session_count, 2);
  });
});

test("token usage store normalizes telemetry events in one place", () => {
  const normalized = store.normalizeTokenTelemetryEvent({
    timestamp: " 2026-04-10T09:00:00.000Z ",
    sessionId: " s1 ",
    provider: " openai ",
    model: " gpt-5.4 ",
    source: " chat ",
    trigger: " manual ",
    eventType: "  ",
    turnIndex: "7.2",
    toolCallCount: "4.8",
    toolNames: [" write ", "read", "read", " archive "],
    inputTokens: "10.9",
    outputTokens: -3,
    costTotal: "0.125",
    costInput: "bad",
    metadata: ["ignored"],
  });
  assert.equal(normalized.timestamp, "2026-04-10T09:00:00.000Z");
  assert.equal(normalized.sessionId, "s1");
  assert.equal(normalized.provider, "openai");
  assert.equal(normalized.model, "gpt-5.4");
  assert.equal(normalized.source, "chat");
  assert.equal(normalized.trigger, "manual");
  assert.equal(normalized.eventType, "event");
  assert.equal(normalized.turnIndex, 7);
  assert.equal(normalized.toolCallCount, 5);
  assert.deepEqual(normalized.toolNames, ["archive", "read", "write"]);
  assert.equal(normalized.inputTokens, 11);
  assert.equal(normalized.outputTokens, 0);
  assert.equal(normalized.costInput, 0);
  assert.equal(normalized.costTotal, 0.125);
  assert.equal(normalized.metadata, null);
});

test("token usage store formats provider_model labels from one shared rule", () => {
  assert.equal(
    store.formatProviderModelLabel("openai", "gpt-5.4"),
    "openai/gpt-5.4",
  );
  assert.equal(
    store.formatProviderModelLabel("", "gpt-5.4-mini"),
    "gpt-5.4-mini",
  );
  assert.equal(store.formatProviderModelLabel("", ""), "(none)");
});

test("token usage store ignores duplicate event ids", async () => {
  await withTempRoot(async (root) => {
    store.appendTokenTelemetryEvent(
      {
        id: "evt-dup",
        timestamp: "2026-04-10T09:00:00.000Z",
        sessionId: "s1",
        eventType: "session_start",
      },
      root,
    );
    store.appendTokenTelemetryEvent(
      {
        id: "evt-dup",
        timestamp: "2026-04-10T09:00:01.000Z",
        sessionId: "s1",
        eventType: "session_start",
      },
      root,
    );

    const rows = store.queryTokenUsageEvents({ agentDir: root, limit: 10 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_type, "session_start");
  });
});

test("token usage store writes structured event fields through one DB mapping", async () => {
  await withTempRoot(async (root) => {
    store.appendTokenTelemetryEvent(
      {
        id: "evt-db-row",
        timestamp: "2026-04-10T09:20:00.000Z",
        sessionId: "s1",
        sessionFile: "/tmp/demo.jsonl",
        sessionName: "demo session",
        sessionPersisted: true,
        cwd: "/work/demo",
        eventType: "message_end",
        source: "chat",
        trigger: "manual",
        turnIndex: 3,
        phase: "turn",
        provider: "openai",
        model: "gpt-5.4",
        thinkingLevel: "medium",
        messageId: "msg-1",
        messageRole: "assistant",
        stopReason: "stop",
        toolCallId: "tool-call-1",
        toolName: "read",
        toolCallCount: 2,
        toolNames: ["write", "read", "read"],
        capabilityKind: "assistant_tool_call",
        capabilityKey: "tools:read+write",
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        totalTokens: 17,
        costInput: 0.01,
        costOutput: 0.02,
        costCacheRead: 0.003,
        costCacheWrite: 0.004,
        costTotal: 0.037,
        contextTokens: 128,
        isError: true,
        metadata: { origin: "test", nested: { ok: true } },
      },
      root,
    );

    const db = store.openTokenUsageDb(root);
    const row = db
      .prepare(
        `
          SELECT
            session_persisted,
            tool_names_json,
            is_error,
            metadata_json,
            total_tokens,
            cost_total
          FROM telemetry_events
          WHERE id = ?
        `,
      )
      .get("evt-db-row");

    assert.equal(row.session_persisted, 1);
    assert.equal(row.is_error, 1);
    assert.equal(row.total_tokens, 17);
    assert.equal(row.cost_total, 0.037);
    assert.deepEqual(JSON.parse(row.tool_names_json), ["read", "write"]);
    assert.deepEqual(JSON.parse(row.metadata_json), {
      origin: "test",
      nested: { ok: true },
    });
  });
});

test("token usage store derives stable ids and tolerates unserializable metadata", async () => {
  await withTempRoot(async (root) => {
    const metadata = {};
    metadata.self = metadata;
    const first = store.appendTokenTelemetryEvent(
      {
        timestamp: "2026-04-10T09:30:00.000Z",
        sessionId: "s1",
        eventType: "message_end",
        capabilityKey: "assistant:text",
        totalTokens: 15,
        metadata,
      },
      root,
    );
    const second = store.appendTokenTelemetryEvent(
      {
        timestamp: "2026-04-10T09:30:00.000Z",
        sessionId: "s1",
        eventType: "message_end",
        capabilityKey: "assistant:text",
        totalTokens: 15,
        metadata,
      },
      root,
    );

    assert.equal(first.id, second.id);
    const rows = store.queryTokenUsageEvents({ agentDir: root, limit: 10 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].total_tokens, 15);
  });
});

test("token usage store canonicalizes tool names before deriving stable ids", async () => {
  await withTempRoot(async (root) => {
    const first = store.appendTokenTelemetryEvent(
      {
        timestamp: "2026-04-10T09:35:00.000Z",
        sessionId: "s1",
        eventType: "message_end",
        capabilityKey: "tools:read+write",
        totalTokens: 21,
        toolNames: ["write", "read"],
      },
      root,
    );
    const second = store.appendTokenTelemetryEvent(
      {
        timestamp: "2026-04-10T09:35:00.000Z",
        sessionId: "s1",
        eventType: "message_end",
        capabilityKey: "tools:read+write",
        totalTokens: 21,
        toolNames: ["read", "write", "read"],
      },
      root,
    );

    assert.equal(first.id, second.id);
    const rows = store.queryTokenUsageEvents({ agentDir: root, limit: 10 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].total_tokens, 21);
  });
});

test("token usage overview normalizes empty sums to zeros", async () => {
  await withTempRoot(async (root) => {
    const overview = store.getTokenUsageOverview({ agentDir: root });
    assert.equal(overview.total_events, 0);
    assert.equal(overview.token_events, 0);
    assert.equal(overview.total_tokens, 0);
    assert.equal(overview.cost_total, 0);
    assert.equal(overview.session_count, 0);
    assert.equal(overview.model_count, 0);
    assert.equal(overview.first_timestamp, "");
    assert.equal(overview.last_timestamp, "");
  });
});

test("token usage store returns recent events in reverse time order", async () => {
  await withTempRoot(async (root) => {
    store.appendTokenTelemetryEvent(
      {
        id: "evt-a",
        timestamp: "2026-04-10T09:00:00.000Z",
        sessionId: "s1",
        eventType: "message_end",
        messageRole: "assistant",
        capabilityKey: "assistant:text",
        totalTokens: 10,
      },
      root,
    );
    store.appendTokenTelemetryEvent(
      {
        id: "evt-b",
        timestamp: "2026-04-10T09:10:00.000Z",
        sessionId: "s1",
        eventType: "message_end",
        messageRole: "assistant",
        capabilityKey: "tool:read",
        totalTokens: 20,
      },
      root,
    );

    const rows = store.queryTokenUsageEvents({ agentDir: root, limit: 10 });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].total_tokens, 20);
    assert.equal(rows[1].total_tokens, 10);
  });
});

test("token usage store exposes a human-oriented session dimension", async () => {
  await withTempRoot(async (root) => {
    store.appendTokenTelemetryEvent(
      {
        id: "evt-session-name",
        timestamp: "2026-04-10T08:00:00.000Z",
        sessionId: "s1",
        sessionName: "named chat",
        sessionFile: "/tmp/ignored.jsonl",
        eventType: "message_end",
        totalTokens: 30,
      },
      root,
    );
    store.appendTokenTelemetryEvent(
      {
        id: "evt-session-file",
        timestamp: "2026-04-10T08:01:00.000Z",
        sessionId: "s2",
        sessionFile: "/tmp/file-backed.jsonl",
        eventType: "message_end",
        totalTokens: 20,
      },
      root,
    );
    store.appendTokenTelemetryEvent(
      {
        id: "evt-session-file-later-sparse",
        timestamp: "2026-04-10T08:01:30.000Z",
        sessionId: "s2",
        eventType: "message_end",
        totalTokens: 5,
      },
      root,
    );
    store.appendTokenTelemetryEvent(
      {
        id: "evt-session-id",
        timestamp: "2026-04-10T08:02:00.000Z",
        sessionId: "s3",
        eventType: "message_end",
        totalTokens: 10,
      },
      root,
    );

    const rows = store.queryTokenUsageAggregate({
      agentDir: root,
      groupBy: ["session"],
      limit: 10,
    });

    assert.deepEqual(
      rows.map((row) => row.session),
      ["named chat", "/tmp/file-backed.jsonl", "s3"],
    );
  });
});

test("token usage hooks keep session metadata and frontend source on later events", async () => {
  await withTempRoot(async (root) => {
    const previousDir = process.env.RIN_DIR;
    process.env.RIN_DIR = root;
    try {
      const module = tokenUsageModule.default({
        cwd: "/work/demo",
        agentDir: root,
        getThinkingLevel: () => "medium",
        sendMessage: () => {},
      });
      const statefulCtx = {
        frontend: { kind: "tui" },
        sessionManager: {
          getSessionId: () => "s1",
          getSessionFile: () => "/tmp/session.jsonl",
          getSessionName: () => "demo",
          getCwd: () => "/work/demo",
          isPersisted: () => true,
        },
      };
      await module.hooks.session_start[0]({ reason: "new" }, statefulCtx);

      const sparseCtx = {
        frontend: { kind: "tui" },
        sessionId: "s1",
      };
      await module.hooks.message_end[0](
        {
          message: {
            id: "m1",
            role: "assistant",
            usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
          },
        },
        sparseCtx,
      );

      const rows = store.queryTokenUsageEvents({ agentDir: root, limit: 10 });
      const message = rows.find((row) => row.event_type === "message_end");
      assert.equal(message.session_file, "/tmp/session.jsonl");
      assert.equal(message.session_name, "demo");
      assert.equal(message.source, "frontend:tui");
    } finally {
      if (previousDir === undefined) delete process.env.RIN_DIR;
      else process.env.RIN_DIR = previousDir;
    }
  });
});

test("token usage store supports shared provider_model and yes/no dimensions", async () => {
  await withTempRoot(async (root) => {
    store.appendTokenTelemetryEvent(
      {
        id: "evt-model-1",
        timestamp: "2026-04-10T08:00:00.000Z",
        sessionId: "s1",
        sessionPersisted: true,
        eventType: "message_end",
        provider: "openai",
        model: "gpt-5.4",
        totalTokens: 30,
      },
      root,
    );
    store.appendTokenTelemetryEvent(
      {
        id: "evt-model-2",
        timestamp: "2026-04-10T08:01:00.000Z",
        sessionId: "s2",
        eventType: "message_end",
        model: "gpt-5.4-mini",
        totalTokens: 20,
      },
      root,
    );
    store.appendTokenTelemetryEvent(
      {
        id: "evt-model-3",
        timestamp: "2026-04-10T08:02:00.000Z",
        sessionId: "s3",
        eventType: "message_end",
        isError: true,
        totalTokens: 5,
      },
      root,
    );

    const byModel = store.queryTokenUsageAggregate({
      agentDir: root,
      groupBy: ["provider_model"],
      includeZero: true,
      limit: 10,
    });
    assert.deepEqual(
      byModel.map((row) => row.provider_model),
      ["openai/gpt-5.4", "gpt-5.4-mini", "(none)"],
    );

    const filteredByModel = store.queryTokenUsageEvents({
      agentDir: root,
      filters: [{ key: "provider_model", value: "openai/gpt-5.4" }],
      limit: 10,
    });
    assert.equal(filteredByModel.length, 1);
    assert.equal(filteredByModel[0].session_id, "s1");

    const persistedRows = store.queryTokenUsageEvents({
      agentDir: root,
      filters: [{ key: "session_persisted", value: "yes" }],
      limit: 10,
    });
    assert.equal(persistedRows.length, 1);
    assert.equal(persistedRows[0].session_id, "s1");

    const erroredRows = store.queryTokenUsageEvents({
      agentDir: root,
      filters: [{ key: "is_error", value: "yes" }],
      limit: 10,
    });
    assert.equal(erroredRows.length, 1);
    assert.equal(erroredRows[0].session_id, "s3");

    const overview = store.getTokenUsageOverview({ agentDir: root });
    assert.equal(overview.model_count, 2);
  });
});

test("token usage store handles repeated cached queries with varying limits", async () => {
  await withTempRoot(async (root) => {
    store.appendTokenTelemetryEvent(
      {
        id: "evt-1",
        timestamp: "2026-04-10T08:00:00.000Z",
        sessionId: "s1",
        eventType: "message_end",
        totalTokens: 10,
      },
      root,
    );
    store.appendTokenTelemetryEvent(
      {
        id: "evt-2",
        timestamp: "2026-04-10T08:01:00.000Z",
        sessionId: "s2",
        eventType: "message_end",
        totalTokens: 20,
      },
      root,
    );
    store.appendTokenTelemetryEvent(
      {
        id: "evt-3",
        timestamp: "2026-04-10T08:02:00.000Z",
        sessionId: "s3",
        eventType: "message_end",
        totalTokens: 30,
      },
      root,
    );

    const recentOne = store.queryTokenUsageEvents({ agentDir: root, limit: 1 });
    assert.equal(recentOne.length, 1);
    assert.equal(recentOne[0].session_id, "s3");

    const recentThree = store.queryTokenUsageEvents({
      agentDir: root,
      limit: 3,
    });
    assert.equal(recentThree.length, 3);
    assert.deepEqual(
      recentThree.map((row) => row.session_id),
      ["s3", "s2", "s1"],
    );

    const topOne = store.queryTokenUsageAggregate({
      agentDir: root,
      groupBy: ["session_id"],
      limit: 1,
    });
    assert.equal(topOne.length, 1);
    assert.equal(topOne[0].session_id, "s3");

    const topThree = store.queryTokenUsageAggregate({
      agentDir: root,
      groupBy: ["session_id"],
      limit: 3,
    });
    assert.equal(topThree.length, 3);
    assert.deepEqual(
      topThree.map((row) => row.session_id),
      ["s3", "s2", "s1"],
    );
  });
});

test("usage report keeps provider_model labels consistent in raw event tables", async () => {
  await withTempRoot(async (root) => {
    store.appendTokenTelemetryEvent(
      {
        id: "evt-none-model",
        timestamp: "2026-04-10T08:00:00.000Z",
        sessionId: "s1",
        eventType: "message_end",
        messageRole: "assistant",
        capabilityKey: "assistant:text",
        totalTokens: 10,
      },
      root,
    );

    const report = usageCli.renderUsageReport(root, {
      groupBy: [],
      filters: [],
      limit: 20,
      orderBy: "total_tokens",
      direction: "desc",
      events: true,
      includeZero: false,
      dimensions: false,
      json: false,
      help: false,
    });

    assert.match(report, /provider_model/);
    assert.match(report, /\(none\)/);
  });
});

test("usage trend series fills 7d 3h buckets for line charts", async () => {
  await withTempRoot(async (root) => {
    store.appendTokenTelemetryEvent(
      {
        id: "evt-trend-outside-window",
        timestamp: "2026-04-10T12:05:00.000Z",
        sessionId: "s1",
        eventType: "message_end",
        messageRole: "assistant",
        totalTokens: 999,
      },
      root,
    );
    store.appendTokenTelemetryEvent(
      {
        id: "evt-trend-first-partial",
        timestamp: "2026-04-10T12:20:00.000Z",
        sessionId: "s1",
        eventType: "message_end",
        messageRole: "assistant",
        totalTokens: 5,
      },
      root,
    );
    store.appendTokenTelemetryEvent(
      {
        id: "evt-trend-a",
        timestamp: "2026-04-10T15:20:00.000Z",
        sessionId: "s1",
        eventType: "message_end",
        messageRole: "assistant",
        totalTokens: 10,
      },
      root,
    );
    store.appendTokenTelemetryEvent(
      {
        id: "evt-trend-b",
        timestamp: "2026-04-10T17:40:00.000Z",
        sessionId: "s1",
        eventType: "message_end",
        messageRole: "assistant",
        totalTokens: 20,
      },
      root,
    );
    store.appendTokenTelemetryEvent(
      {
        id: "evt-trend-c",
        timestamp: "2026-04-11T00:00:00.000Z",
        sessionId: "s2",
        eventType: "message_end",
        messageRole: "assistant",
        totalTokens: 70,
      },
      root,
    );

    const series = usageCli.buildUsageTrendSeries(root, {
      now: "2026-04-17T12:10:00.000Z",
      days: 7,
      bucketHours: 3,
    });

    assert.equal(series.bucketHours, 3);
    assert.equal(series.points.length, 57);
    assert.equal(series.points[0].timestamp, "2026-04-10T12:00:00.000Z");
    assert.equal(series.points[0].total_tokens, 5);
    assert.equal(
      series.points.find(
        (point) => point.timestamp === "2026-04-10T15:00:00.000Z",
      )?.total_tokens,
      30,
    );
    assert.equal(
      series.points.find(
        (point) => point.timestamp === "2026-04-11T00:00:00.000Z",
      )?.total_tokens,
      70,
    );
    assert.equal(series.points[2].total_tokens, 0);
  });
});

test("usage report renders a compact 7d text line chart", async () => {
  await withTempRoot(async (root) => {
    store.appendTokenTelemetryEvent(
      {
        id: "evt-text-trend-a",
        timestamp: new Date(Date.now() - 6 * 86_400_000).toISOString(),
        sessionId: "s1",
        eventType: "message_end",
        messageRole: "assistant",
        totalTokens: 10,
      },
      root,
    );
    store.appendTokenTelemetryEvent(
      {
        id: "evt-text-trend-b",
        timestamp: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        sessionId: "s1",
        eventType: "message_end",
        messageRole: "assistant",
        totalTokens: 80,
      },
      root,
    );

    const report = usageCli.renderUsageReport(root, {
      groupBy: [],
      filters: [],
      limit: 20,
      orderBy: "total_tokens",
      direction: "desc",
      events: false,
      includeZero: false,
      dimensions: false,
      json: false,
      help: false,
    });

    assert.match(report, /7d usage trend/);
    assert.match(report, /3h buckets/);
    assert.match(report, /[╱╲─•]/);
    assert.doesNotMatch(report, /recent usage/);
  });
});

test("usage trend image writer produces a PNG chart artifact", async () => {
  await withTempRoot(async (root) => {
    store.appendTokenTelemetryEvent(
      {
        id: "evt-png-trend",
        timestamp: "2026-04-16T12:00:00.000Z",
        sessionId: "s1",
        eventType: "message_end",
        messageRole: "assistant",
        totalTokens: 100,
      },
      root,
    );

    const imagePath = usageCli.writeUsageTrendChartImage(root, {
      now: "2026-04-17T12:10:00.000Z",
      days: 7,
      bucketHours: 3,
    });
    const image = await fs.readFile(imagePath);

    assert.match(path.basename(imagePath), /^usage-7d-.*\.png$/);
    assert.deepEqual(
      [...image.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );
  });
});

test("usage dashboard renders Codex subscription quota and token charts", async () => {
  await withTempRoot(async (root) => {
    store.appendTokenTelemetryEvent(
      {
        id: "evt-dashboard-chart",
        timestamp: "2026-04-10T08:00:00.000Z",
        sessionId: "s1",
        eventType: "message_end",
        messageRole: "assistant",
        provider: "openai-codex",
        model: "gpt-5.5",
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100,
        costTotal: 0.25,
      },
      root,
    );

    const report = usageCli.renderUsageReport(
      root,
      {
        groupBy: [],
        filters: [],
        limit: 20,
        orderBy: "total_tokens",
        direction: "desc",
        events: false,
        includeZero: false,
        dimensions: false,
        json: false,
        help: false,
      },
      [
        {
          provider: "openai-codex",
          label: "ChatGPT Codex",
          configured: true,
          accountName: "rin@example.test",
          plan: "pro",
          windows: [
            {
              name: "five_hour",
              percentLeft: 75,
              resetAt: "2026-04-10T13:00:00.000Z",
            },
            {
              name: "weekly",
              percentLeft: 40,
              resetAt: "2026-04-17T08:00:00.000Z",
            },
          ],
        },
        {
          provider: "google-gemini-cli",
          label: "Gemini CLI",
          configured: true,
          accountName: "gemini@example.test",
          windows: [],
          error: "quota unavailable",
        },
      ],
    );

    assert.match(report, /accounts & quota/);
    assert.match(report, /ChatGPT Codex\s+rin@example\.test \(pro\)/);
    assert.match(report, /5-hour\s+█+░+ 75% left · reset/);
    assert.match(report, /weekly\s+█+░+ 40% left · reset/);
    assert.match(report, /Gemini CLI\s+gemini@example\.test/);
    assert.match(report, /temporarily unavailable \(quota unavailable\)/);
    assert.match(report, /7d usage trend/);
    assert.match(report, /3h buckets/);
    assert.doesNotMatch(report, /recent usage/);
    assert.doesNotMatch(report, /\b5h\b/);
    assert.doesNotMatch(report, /\b1d\b/);

    const backendJson = JSON.parse(
      usageCli.renderUsageReport(
        root,
        {
          groupBy: [],
          filters: [],
          from: "2026-04-01T00:00:00.000Z",
          limit: 20,
          orderBy: "total_tokens",
          direction: "desc",
          events: false,
          includeZero: false,
          dimensions: false,
          json: true,
          help: false,
        },
        [
          {
            provider: "openai-codex",
            label: "ChatGPT Codex",
            configured: true,
            windows: [{ name: "five_hour", percentLeft: 75 }],
          },
        ],
      ),
    );
    assert.equal(backendJson.providerQuotas[0].provider, "openai-codex");
    assert.equal(backendJson.overview.total_tokens, 100);

    const backendReport = usageCli.renderUsageReport(root, {
      groupBy: [],
      filters: [],
      from: "2026-04-01T00:00:00.000Z",
      limit: 20,
      orderBy: "total_tokens",
      direction: "desc",
      events: false,
      includeZero: false,
      dimensions: false,
      json: false,
      help: false,
    });
    assert.match(backendReport, /overview/);
    assert.match(backendReport, /top sessions/);
    assert.doesNotMatch(backendReport, /top sources/);
    assert.match(backendReport, /top hours/);
    assert.match(backendReport, /chart/);
  });
});

test("Codex subscription usage parser accepts current wham usage shape", () => {
  const parsed = usageCli.parseCodexSubscriptionUsage({
    email: "rin@example.test",
    plan_type: "pro",
    rate_limit: {
      primary_window: {
        used_percent: 25,
        limit_window_seconds: 18000,
        reset_at: 1777551566,
      },
      secondary_window: {
        percent_left: 40,
        limit_window_seconds: 604800,
        reset_at: 1777974883,
      },
    },
    credits: { balance: "0" },
  });

  assert.equal(parsed.accountName, "rin@example.test");
  assert.equal(parsed.plan, "pro");
  assert.equal(parsed.windows[0].name, "five_hour");
  assert.equal(parsed.windows[0].percentLeft, 75);
  assert.equal(parsed.windows[1].name, "weekly");
  assert.equal(parsed.windows[1].percentLeft, 40);
  assert.equal(parsed.credits, "0");
});

test("Anthropic subscription usage parser accepts OAuth usage shape", () => {
  const parsed = usageCli.parseAnthropicSubscriptionUsage({
    five_hour: {
      utilization: 25,
      resets_at: "2026-04-10T13:00:00.000Z",
    },
    seven_day: {
      utilization: 60,
      resets_at: "2026-04-17T08:00:00.000Z",
    },
    extra_usage: {
      used_credits: 125,
      monthly_limit: 2000,
    },
  });

  assert.equal(parsed.windows[0].name, "five_hour");
  assert.equal(parsed.windows[0].percentLeft, 75);
  assert.equal(parsed.windows[1].name, "seven_day");
  assert.equal(parsed.windows[1].percentLeft, 40);
  assert.equal(parsed.credits, "1.25/20.00");
});
