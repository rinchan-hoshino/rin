import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { coreDataPath } from "../data-layout.js";
import os from "node:os";

import BetterSqlite3 from "better-sqlite3";
import { nowIso } from "../time-utils.js";
import { safeString } from "../text-utils.js";

export type TokenTelemetryEvent = {
  id?: string;
  timestamp?: string;
  sessionId?: string;
  sessionFile?: string;
  sessionName?: string;
  sessionPersisted?: boolean;
  cwd?: string;
  eventType: string;
  source?: string;
  trigger?: string;
  turnIndex?: number | null;
  phase?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  messageId?: string;
  messageRole?: string;
  stopReason?: string;
  toolCallId?: string;
  toolName?: string;
  toolCallCount?: number;
  toolNames?: string[];
  capabilityKind?: string;
  capabilityKey?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costInput?: number;
  costOutput?: number;
  costCacheRead?: number;
  costCacheWrite?: number;
  costTotal?: number;
  contextTokens?: number;
  isError?: boolean;
  metadata?: Record<string, unknown> | null;
};

export type TokenUsageQueryOptions = {
  agentDir?: string;
  from?: string;
  to?: string;
  groupBy?: string[];
  filters?: Array<{ key: string; value: string }>;
  limit?: number;
  orderBy?: string;
  direction?: "asc" | "desc";
  includeZero?: boolean;
};

const dbCache = new Map<string, BetterSqlite3.Database>();
const statementCache = new WeakMap<BetterSqlite3.Database, Map<string, any>>();
type TokenTelemetryBatch = {
  agentDir: string;
  rows: Array<Record<string, unknown>>;
  timer?: NodeJS.Timeout;
  lastWarningAt?: number;
};
const telemetryBatches = new Map<string, TokenTelemetryBatch>();

const TELEMETRY_BATCH_SIZE = 32;
const TELEMETRY_BATCH_FLUSH_MS = 1_000;
const DEFAULT_AGGREGATE_LIMIT = 20;
const DEFAULT_EVENTS_LIMIT = 40;
const MAX_QUERY_LIMIT = 500;
const EMPTY_DIMENSION_VALUE = "(none)";

const AGGREGATE_METRICS = [
  { key: "rows", select: `COUNT(*)` },
  {
    key: "token_events",
    select: `SUM(CASE WHEN total_tokens > 0 THEN 1 ELSE 0 END)`,
  },
  { key: "input_tokens", select: `SUM(input_tokens)` },
  { key: "output_tokens", select: `SUM(output_tokens)` },
  { key: "cache_read_tokens", select: `SUM(cache_read_tokens)` },
  { key: "cache_write_tokens", select: `SUM(cache_write_tokens)` },
  { key: "total_tokens", select: `SUM(total_tokens)` },
  { key: "cost_total", select: `SUM(cost_total)` },
  { key: "context_tokens", select: `MAX(context_tokens)` },
] as const;

const AGGREGATE_ORDER_FIELDS = new Set(
  AGGREGATE_METRICS.map((metric) => metric.key),
);
const OVERVIEW_INT_FIELDS = [
  "total_events",
  "token_events",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "total_tokens",
  "session_count",
  "model_count",
] as const;
const OVERVIEW_FLOAT_FIELDS = ["cost_total"] as const;
const TELEMETRY_EVENT_INSERT_COLUMNS = [
  "id",
  "timestamp",
  "session_id",
  "session_file",
  "session_name",
  "session_persisted",
  "cwd",
  "event_type",
  "source",
  "trigger",
  "turn_index",
  "phase",
  "provider",
  "model",
  "thinking_level",
  "message_id",
  "message_role",
  "stop_reason",
  "tool_call_id",
  "tool_name",
  "tool_call_count",
  "tool_names_json",
  "capability_kind",
  "capability_key",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "total_tokens",
  "cost_input",
  "cost_output",
  "cost_cache_read",
  "cost_cache_write",
  "cost_total",
  "context_tokens",
  "is_error",
  "metadata_json",
] as const;
const TELEMETRY_EVENT_INSERT_SQL = `
  INSERT OR IGNORE INTO telemetry_events (
    ${TELEMETRY_EVENT_INSERT_COLUMNS.join(",\n    ")}
  ) VALUES (
    ${TELEMETRY_EVENT_INSERT_COLUMNS.map((column) => `@${column}`).join(",\n    ")}
  )
`;
const RECENT_EVENT_SELECT_COLUMNS = [
  "timestamp",
  "session_id",
  "session_name",
  "session_file",
  "source",
  "event_type",
  "provider",
  "model",
  "thinking_level",
  "message_role",
  "stop_reason",
  "tool_name",
  "capability_kind",
  "capability_key",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "total_tokens",
  "cost_total",
  "turn_index",
  "is_error",
] as const;

export type NormalizedTokenTelemetryEvent = {
  id: string;
  timestamp: string;
  sessionId: string;
  sessionFile: string;
  sessionName: string;
  sessionPersisted: boolean;
  cwd: string;
  eventType: string;
  source: string;
  trigger: string;
  turnIndex: number | null;
  phase: string;
  provider: string;
  model: string;
  thinkingLevel: string;
  messageId: string;
  messageRole: string;
  stopReason: string;
  toolCallId: string;
  toolName: string;
  toolCallCount: number;
  toolNames: string[];
  capabilityKind: string;
  capabilityKey: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  costTotal: number;
  contextTokens: number;
  isError: boolean;
  metadata: Record<string, unknown> | null;
};

const TELEMETRY_TEXT_FIELDS = [
  "timestamp",
  "sessionId",
  "sessionFile",
  "sessionName",
  "cwd",
  "eventType",
  "source",
  "trigger",
  "phase",
  "provider",
  "model",
  "thinkingLevel",
  "messageId",
  "messageRole",
  "stopReason",
  "toolCallId",
  "toolName",
  "capabilityKind",
  "capabilityKey",
] as const satisfies ReadonlyArray<keyof TokenTelemetryEvent>;

const TELEMETRY_INT_FIELDS = [
  "toolCallCount",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "totalTokens",
  "contextTokens",
] as const satisfies ReadonlyArray<keyof TokenTelemetryEvent>;

const TELEMETRY_FLOAT_FIELDS = [
  "costInput",
  "costOutput",
  "costCacheRead",
  "costCacheWrite",
  "costTotal",
] as const satisfies ReadonlyArray<keyof TokenTelemetryEvent>;

function normalizeText(value: unknown): string {
  return safeString(value).trim();
}

function safeNumber(value: unknown): number {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
}

function normalizeInt(value: unknown): number {
  return Math.max(0, Math.round(safeNumber(value)));
}

function normalizeOptionalInt(value: unknown): number | null {
  if (value == null || normalizeText(value) === "") return null;
  return Math.round(safeNumber(value));
}

function normalizeMetadata(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeTelemetryTextFields(event: TokenTelemetryEvent) {
  return Object.fromEntries(
    TELEMETRY_TEXT_FIELDS.map((key) => [key, normalizeText(event[key])]),
  ) as Record<(typeof TELEMETRY_TEXT_FIELDS)[number], string>;
}

function normalizeTelemetryIntFields(event: TokenTelemetryEvent) {
  return Object.fromEntries(
    TELEMETRY_INT_FIELDS.map((key) => [key, normalizeInt(event[key])]),
  ) as Record<(typeof TELEMETRY_INT_FIELDS)[number], number>;
}

function normalizeTelemetryFloatFields(event: TokenTelemetryEvent) {
  return Object.fromEntries(
    TELEMETRY_FLOAT_FIELDS.map((key) => [key, safeNumber(event[key])]),
  ) as Record<(typeof TELEMETRY_FLOAT_FIELDS)[number], number>;
}

function textOrNull(value: string): string | null {
  return value || null;
}

function sqliteBool(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

function safeJsonStringify(value: unknown): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function clampQueryLimit(value: unknown, fallback: number): number {
  return Math.max(
    1,
    Math.min(MAX_QUERY_LIMIT, Math.round(safeNumber(value || fallback))),
  );
}

function normalizeOverviewRow(row: any) {
  const normalized = { ...(row || {}) };
  for (const key of OVERVIEW_INT_FIELDS) {
    normalized[key] = normalizeInt(row?.[key]);
  }
  for (const key of OVERVIEW_FLOAT_FIELDS) {
    normalized[key] = safeNumber(row?.[key]);
  }
  normalized.first_timestamp = normalizeText(row?.first_timestamp);
  normalized.last_timestamp = normalizeText(row?.last_timestamp);
  return normalized;
}

type DimensionDef = {
  select: string;
  filter?: string;
};

function coalescedTextDimensionExpr(valueExpr: string): string {
  return `COALESCE(NULLIF(${valueExpr}, ''), '${EMPTY_DIMENSION_VALUE}')`;
}

function yesNoDimensionExpr(condition: string): string {
  return `CASE WHEN ${condition} THEN 'yes' ELSE 'no' END`;
}

function buildDimension(select: string, filter = select): DimensionDef {
  return { select, filter };
}

function textDimension(column: string): DimensionDef {
  return buildDimension(coalescedTextDimensionExpr(column));
}

function yesNoDimension(condition: string): DimensionDef {
  return buildDimension(yesNoDimensionExpr(condition));
}

const PROVIDER_MODEL_VALUE_EXPR = [
  `CASE`,
  `  WHEN COALESCE(provider, '') <> '' AND COALESCE(model, '') <> '' THEN provider || '/' || model`,
  `  WHEN COALESCE(model, '') <> '' THEN model`,
  `  ELSE ''`,
  `END`,
].join(" ");
const PROVIDER_MODEL_DIMENSION_EXPR = coalescedTextDimensionExpr(
  PROVIDER_MODEL_VALUE_EXPR,
);
const SESSION_VALUE_EXPR = [
  `CASE`,
  `  WHEN COALESCE(session_name, '') <> '' THEN session_name`,
  `  WHEN COALESCE(session_labels.resolved_session_name, '') <> '' THEN session_labels.resolved_session_name`,
  `  WHEN COALESCE(session_file, '') <> '' THEN session_file`,
  `  WHEN COALESCE(session_labels.resolved_session_file, '') <> '' THEN session_labels.resolved_session_file`,
  `  WHEN COALESCE(session_id, '') <> '' THEN session_id`,
  `  ELSE ''`,
  `END`,
].join(" ");
const SESSION_DIMENSION_EXPR = coalescedTextDimensionExpr(SESSION_VALUE_EXPR);

export function formatProviderModelLabel(
  provider: unknown,
  model: unknown,
): string {
  const normalizedProvider = normalizeText(provider);
  const normalizedModel = normalizeText(model);
  if (normalizedProvider && normalizedModel)
    return `${normalizedProvider}/${normalizedModel}`;
  return normalizedModel || EMPTY_DIMENSION_VALUE;
}

function resolveDimensionDef(
  key: string,
  errorPrefix: "unsupported_filter" | "unsupported_group_by",
): Required<DimensionDef> {
  const def = DIMENSIONS[key];
  if (!def) throw new Error(`${errorPrefix}:${key}`);
  return { select: def.select, filter: def.filter || def.select };
}

export function resolveAgentDir(agentDir = ""): string {
  const fromEnv = safeString(process.env.RIN_DIR).trim();
  if (safeString(agentDir).trim()) return path.resolve(agentDir);
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), ".rin");
}

export function resolveTokenUsageRoot(agentDir = ""): string {
  return coreDataPath(resolveAgentDir(agentDir), "usage");
}

export function resolveTokenUsageDbPath(agentDir = ""): string {
  return path.join(resolveTokenUsageRoot(agentDir), "usage.db");
}

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function initDb(db: BetterSqlite3.Database) {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS telemetry_events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      session_id TEXT,
      session_file TEXT,
      session_name TEXT,
      session_persisted INTEGER NOT NULL DEFAULT 0,
      cwd TEXT,
      event_type TEXT NOT NULL,
      source TEXT,
      trigger TEXT,
      turn_index INTEGER,
      phase TEXT,
      provider TEXT,
      model TEXT,
      thinking_level TEXT,
      message_id TEXT,
      message_role TEXT,
      stop_reason TEXT,
      tool_call_id TEXT,
      tool_name TEXT,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      tool_names_json TEXT,
      capability_kind TEXT,
      capability_key TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_input REAL NOT NULL DEFAULT 0,
      cost_output REAL NOT NULL DEFAULT 0,
      cost_cache_read REAL NOT NULL DEFAULT 0,
      cost_cache_write REAL NOT NULL DEFAULT 0,
      cost_total REAL NOT NULL DEFAULT 0,
      context_tokens INTEGER NOT NULL DEFAULT 0,
      is_error INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT
    );

    CREATE INDEX IF NOT EXISTS telemetry_events_timestamp_idx
      ON telemetry_events(timestamp);
    CREATE INDEX IF NOT EXISTS telemetry_events_session_idx
      ON telemetry_events(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS telemetry_events_event_type_idx
      ON telemetry_events(event_type, timestamp);
    CREATE INDEX IF NOT EXISTS telemetry_events_model_idx
      ON telemetry_events(provider, model, timestamp);
    CREATE INDEX IF NOT EXISTS telemetry_events_source_idx
      ON telemetry_events(source, timestamp);
    CREATE INDEX IF NOT EXISTS telemetry_events_capability_idx
      ON telemetry_events(capability_key, timestamp);

    DROP INDEX IF EXISTS telemetry_events_tokens_idx;
  `);
}

function prepareCached(db: BetterSqlite3.Database, sql: string) {
  let statements = statementCache.get(db);
  if (!statements) {
    statements = new Map();
    statementCache.set(db, statements);
  }
  let statement = statements.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    statements.set(sql, statement);
  }
  return statement;
}

export function openTokenUsageDb(agentDir = ""): BetterSqlite3.Database {
  const dbPath = resolveTokenUsageDbPath(agentDir);
  const existing = dbCache.get(dbPath);
  if (existing) return existing;
  ensureParentDir(dbPath);
  const db = new BetterSqlite3(dbPath);
  initDb(db);
  dbCache.set(dbPath, db);
  return db;
}

function normalizeToolNames(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(input.map((item) => safeString(item).trim()).filter(Boolean)),
  ).sort();
}

function stableEventId(
  event: Omit<NormalizedTokenTelemetryEvent, "id">,
): string {
  const seed = [
    event.timestamp,
    event.sessionId,
    event.sessionFile,
    event.eventType,
    event.messageId,
    event.toolCallId,
    String(event.turnIndex ?? ""),
    event.capabilityKey,
    event.provider,
    event.model,
    event.messageRole,
    event.toolName,
    String(event.totalTokens),
    safeJsonStringify(event.toolNames) || "[]",
  ].join("|");
  const digest = crypto
    .createHash("sha256")
    .update(seed)
    .digest("hex")
    .slice(0, 24);
  return `evt_${digest}`;
}

export function normalizeTokenTelemetryEvent(
  event: TokenTelemetryEvent,
): NormalizedTokenTelemetryEvent {
  const textFields = normalizeTelemetryTextFields(event);
  const intFields = normalizeTelemetryIntFields(event);
  const floatFields = normalizeTelemetryFloatFields(event);
  const normalizedWithoutId = {
    timestamp: textFields.timestamp || nowIso(),
    sessionId: textFields.sessionId,
    sessionFile: textFields.sessionFile,
    sessionName: textFields.sessionName,
    sessionPersisted: Boolean(event.sessionPersisted),
    cwd: textFields.cwd,
    eventType: textFields.eventType || "event",
    source: textFields.source,
    trigger: textFields.trigger,
    turnIndex: normalizeOptionalInt(event.turnIndex),
    phase: textFields.phase,
    provider: textFields.provider,
    model: textFields.model,
    thinkingLevel: textFields.thinkingLevel,
    messageId: textFields.messageId,
    messageRole: textFields.messageRole,
    stopReason: textFields.stopReason,
    toolCallId: textFields.toolCallId,
    toolName: textFields.toolName,
    toolCallCount: intFields.toolCallCount,
    toolNames: normalizeToolNames(event.toolNames),
    capabilityKind: textFields.capabilityKind,
    capabilityKey: textFields.capabilityKey,
    inputTokens: intFields.inputTokens,
    outputTokens: intFields.outputTokens,
    cacheReadTokens: intFields.cacheReadTokens,
    cacheWriteTokens: intFields.cacheWriteTokens,
    totalTokens: intFields.totalTokens,
    costInput: floatFields.costInput,
    costOutput: floatFields.costOutput,
    costCacheRead: floatFields.costCacheRead,
    costCacheWrite: floatFields.costCacheWrite,
    costTotal: floatFields.costTotal,
    contextTokens: intFields.contextTokens,
    isError: Boolean(event.isError),
    metadata: normalizeMetadata(event.metadata),
  } satisfies Omit<NormalizedTokenTelemetryEvent, "id">;
  return {
    id: normalizeText(event.id) || stableEventId(normalizedWithoutId),
    ...normalizedWithoutId,
  };
}

function toTelemetryEventDbRow(normalized: NormalizedTokenTelemetryEvent) {
  return {
    id: normalized.id,
    timestamp: normalized.timestamp,
    session_id: textOrNull(normalized.sessionId),
    session_file: textOrNull(normalized.sessionFile),
    session_name: textOrNull(normalized.sessionName),
    session_persisted: sqliteBool(normalized.sessionPersisted),
    cwd: textOrNull(normalized.cwd),
    event_type: normalized.eventType,
    source: textOrNull(normalized.source),
    trigger: textOrNull(normalized.trigger),
    turn_index: normalized.turnIndex,
    phase: textOrNull(normalized.phase),
    provider: textOrNull(normalized.provider),
    model: textOrNull(normalized.model),
    thinking_level: textOrNull(normalized.thinkingLevel),
    message_id: textOrNull(normalized.messageId),
    message_role: textOrNull(normalized.messageRole),
    stop_reason: textOrNull(normalized.stopReason),
    tool_call_id: textOrNull(normalized.toolCallId),
    tool_name: textOrNull(normalized.toolName),
    tool_call_count: normalized.toolCallCount,
    tool_names_json: safeJsonStringify(
      normalized.toolNames.length ? normalized.toolNames : null,
    ),
    capability_kind: textOrNull(normalized.capabilityKind),
    capability_key: textOrNull(normalized.capabilityKey),
    input_tokens: normalized.inputTokens,
    output_tokens: normalized.outputTokens,
    cache_read_tokens: normalized.cacheReadTokens,
    cache_write_tokens: normalized.cacheWriteTokens,
    total_tokens: normalized.totalTokens,
    cost_input: normalized.costInput,
    cost_output: normalized.costOutput,
    cost_cache_read: normalized.costCacheRead,
    cost_cache_write: normalized.costCacheWrite,
    cost_total: normalized.costTotal,
    context_tokens: normalized.contextTokens,
    is_error: sqliteBool(normalized.isError),
    metadata_json: safeJsonStringify(normalized.metadata),
  } satisfies Record<(typeof TELEMETRY_EVENT_INSERT_COLUMNS)[number], unknown>;
}

function warnTokenTelemetryFlushFailure(
  batch: TokenTelemetryBatch,
  error: unknown,
) {
  const now = Date.now();
  if (now - Number(batch.lastWarningAt || 0) < 60_000) return;
  batch.lastWarningAt = now;
  process.emitWarning(
    "Rin token telemetry flush failed; pending events will be retried.",
    {
      code: "RIN_TOKEN_TELEMETRY_FLUSH_FAILED",
      detail: safeString((error as any)?.message || error).trim(),
    },
  );
}

function scheduleTokenTelemetryFlush(
  dbPath: string,
  batch: TokenTelemetryBatch,
) {
  if (batch.timer) return;
  batch.timer = setTimeout(() => {
    batch.timer = undefined;
    try {
      flushTokenTelemetryEvents(batch.agentDir);
    } catch (error) {
      warnTokenTelemetryFlushFailure(batch, error);
      if (batch.rows.length > 0) scheduleTokenTelemetryFlush(dbPath, batch);
    }
  }, TELEMETRY_BATCH_FLUSH_MS);
  batch.timer.unref?.();
}

export function flushTokenTelemetryEvents(agentDir = ""): number {
  const resolvedAgentDir = resolveAgentDir(agentDir);
  const dbPath = resolveTokenUsageDbPath(resolvedAgentDir);
  const batch = telemetryBatches.get(dbPath);
  if (!batch || batch.rows.length === 0) return 0;
  if (batch.timer) {
    clearTimeout(batch.timer);
    batch.timer = undefined;
  }
  const rows = batch.rows.splice(0);
  try {
    const db = openTokenUsageDb(resolvedAgentDir);
    const statement = prepareCached(db, TELEMETRY_EVENT_INSERT_SQL);
    db.transaction((pendingRows: Array<Record<string, unknown>>) => {
      for (const row of pendingRows) statement.run(row);
    })(rows);
    if (batch.rows.length === 0) telemetryBatches.delete(dbPath);
    else scheduleTokenTelemetryFlush(dbPath, batch);
    return rows.length;
  } catch (error) {
    batch.rows.unshift(...rows);
    scheduleTokenTelemetryFlush(dbPath, batch);
    throw error;
  }
}

export function queueTokenTelemetryEvent(
  event: TokenTelemetryEvent,
  agentDir = "",
): { id: string } {
  const resolvedAgentDir = resolveAgentDir(agentDir);
  const dbPath = resolveTokenUsageDbPath(resolvedAgentDir);
  const normalized = normalizeTokenTelemetryEvent(event);
  let batch = telemetryBatches.get(dbPath);
  if (!batch) {
    batch = { agentDir: resolvedAgentDir, rows: [] };
    telemetryBatches.set(dbPath, batch);
  }
  if (batch.rows.length >= TELEMETRY_BATCH_SIZE) {
    flushTokenTelemetryEvents(resolvedAgentDir);
    batch = telemetryBatches.get(dbPath);
    if (!batch) {
      batch = { agentDir: resolvedAgentDir, rows: [] };
      telemetryBatches.set(dbPath, batch);
    }
  }
  batch.rows.push(toTelemetryEventDbRow(normalized));
  if (batch.rows.length >= TELEMETRY_BATCH_SIZE) {
    flushTokenTelemetryEvents(resolvedAgentDir);
  } else {
    scheduleTokenTelemetryFlush(dbPath, batch);
  }
  return { id: normalized.id };
}

export function appendTokenTelemetryEvent(
  event: TokenTelemetryEvent,
  agentDir = "",
): { id: string } {
  const db = openTokenUsageDb(agentDir);
  const normalized = normalizeTokenTelemetryEvent(event);
  prepareCached(db, TELEMETRY_EVENT_INSERT_SQL).run(
    toTelemetryEventDbRow(normalized),
  );
  return { id: normalized.id };
}

export function getTokenUsageOverview(
  options: Omit<
    TokenUsageQueryOptions,
    "groupBy" | "orderBy" | "direction"
  > = {},
) {
  flushTokenTelemetryEvents(options.agentDir || "");
  const db = openTokenUsageDb(options.agentDir || "");
  const { whereSql, params } = buildWhereClause(options, false);
  return normalizeOverviewRow(
    prepareCached(
      db,
      `
        SELECT
          COUNT(*) AS total_events,
          SUM(CASE WHEN total_tokens > 0 THEN 1 ELSE 0 END) AS token_events,
          SUM(input_tokens) AS input_tokens,
          SUM(output_tokens) AS output_tokens,
          SUM(cache_read_tokens) AS cache_read_tokens,
          SUM(cache_write_tokens) AS cache_write_tokens,
          SUM(total_tokens) AS total_tokens,
          SUM(cost_total) AS cost_total,
          COUNT(DISTINCT NULLIF(session_id, '')) AS session_count,
          COUNT(DISTINCT NULLIF(${PROVIDER_MODEL_VALUE_EXPR}, '')) AS model_count,
          MIN(timestamp) AS first_timestamp,
          MAX(timestamp) AS last_timestamp
        FROM telemetry_events
        ${whereSql}
      `,
    ).get(params),
  );
}

const DIMENSIONS = {
  day: buildDimension(`substr(timestamp, 1, 10)`),
  hour: buildDimension(`substr(timestamp, 1, 13) || ':00'`),
  session: buildDimension(SESSION_DIMENSION_EXPR),
  session_id: textDimension(`session_id`),
  session_name: textDimension(`session_name`),
  session_file: textDimension(`session_file`),
  session_persisted: yesNoDimension(`session_persisted = 1`),
  cwd: textDimension(`cwd`),
  event_type: textDimension(`event_type`),
  source: textDimension(`source`),
  trigger: textDimension(`trigger`),
  provider: textDimension(`provider`),
  model: textDimension(`model`),
  provider_model: buildDimension(PROVIDER_MODEL_DIMENSION_EXPR),
  thinking_level: textDimension(`thinking_level`),
  message_role: textDimension(`message_role`),
  stop_reason: textDimension(`stop_reason`),
  tool_name: textDimension(`tool_name`),
  capability: textDimension(`capability_key`),
  capability_kind: textDimension(`capability_kind`),
  turn_index: buildDimension(
    `COALESCE(CAST(turn_index AS TEXT), '${EMPTY_DIMENSION_VALUE}')`,
  ),
  is_error: yesNoDimension(`is_error = 1`),
} satisfies Record<string, DimensionDef>;

export function listTokenUsageDimensions(): string[] {
  return Object.keys(DIMENSIONS).sort();
}

function buildWhereClause(
  options: TokenUsageQueryOptions,
  forAggregate: boolean,
) {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (safeString(options.from).trim()) {
    clauses.push(`timestamp >= @from`);
    params.from = safeString(options.from).trim();
  }
  if (safeString(options.to).trim()) {
    clauses.push(`timestamp <= @to`);
    params.to = safeString(options.to).trim();
  }
  if (forAggregate && !options.includeZero) {
    clauses.push(`total_tokens > 0`);
  }
  for (const [index, filter] of (options.filters || []).entries()) {
    const key = normalizeText(filter.key);
    const def = resolveDimensionDef(key, "unsupported_filter");
    const paramKey = `filter_${index}`;
    clauses.push(`${def.filter} = @${paramKey}`);
    params[paramKey] = normalizeText(filter.value);
  }
  return {
    whereSql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function queryUsesSessionLabels(
  options: TokenUsageQueryOptions,
  groupBy: string[] = [],
) {
  return (
    groupBy.some((key) => normalizeText(key) === "session") ||
    (options.filters || []).some(
      (filter) => normalizeText(filter.key) === "session",
    )
  );
}

function aggregateTelemetrySource(options: TokenUsageQueryOptions) {
  if ((options.filters || []).length > 0) return "telemetry_events";
  if (safeString(options.from).trim() || safeString(options.to).trim()) {
    return "telemetry_events INDEXED BY telemetry_events_timestamp_idx";
  }
  if (!options.includeZero) return "telemetry_events NOT INDEXED";
  return "telemetry_events";
}

function buildSessionLabelsQueryParts(
  options: TokenUsageQueryOptions,
  enabled: boolean,
  forAggregate: boolean,
) {
  const eventSource = forAggregate
    ? aggregateTelemetrySource(options)
    : "telemetry_events";
  if (!enabled) {
    return { withSql: "", fromSql: eventSource };
  }
  const scopeClauses = [`COALESCE(session_id, '') <> ''`];
  if (safeString(options.from).trim()) {
    scopeClauses.push(`timestamp >= @from`);
  }
  if (safeString(options.to).trim()) {
    scopeClauses.push(`timestamp <= @to`);
  }
  if (forAggregate && !options.includeZero) {
    scopeClauses.push(`total_tokens > 0`);
  }
  const hasTimeRange = Boolean(
    safeString(options.from).trim() || safeString(options.to).trim(),
  );
  const scopeIndex = hasTimeRange
    ? " INDEXED BY telemetry_events_timestamp_idx"
    : forAggregate && !options.includeZero
      ? " NOT INDEXED"
      : "";
  const labelEventsIndex = hasTimeRange
    ? " INDEXED BY telemetry_events_session_idx"
    : " NOT INDEXED";
  return {
    withSql: `
      WITH scoped_session_ids AS MATERIALIZED (
        SELECT session_id
        FROM telemetry_events${scopeIndex}
        WHERE ${scopeClauses.join(" AND ")}
      ),
      session_ids AS MATERIALIZED (
        SELECT DISTINCT session_id AS label_session_id
        FROM scoped_session_ids
      ),
      session_label_times AS MATERIALIZED (
        SELECT
          events.session_id AS label_session_id,
          MAX(
            CASE WHEN COALESCE(events.session_name, '') <> ''
              THEN events.timestamp END
          ) AS name_timestamp,
          MAX(
            CASE WHEN COALESCE(events.session_file, '') <> ''
              THEN events.timestamp END
          ) AS file_timestamp
        FROM session_ids
        INNER JOIN telemetry_events AS events${labelEventsIndex}
          ON events.session_id = session_ids.label_session_id
        GROUP BY events.session_id
      ),
      session_labels AS MATERIALIZED (
        SELECT
          label_session_id,
          (
            SELECT session_lookup.session_name
            FROM telemetry_events AS session_lookup
            WHERE session_lookup.session_id = session_label_times.label_session_id
              AND session_lookup.timestamp = session_label_times.name_timestamp
              AND COALESCE(session_lookup.session_name, '') <> ''
            LIMIT 1
          ) AS resolved_session_name,
          (
            SELECT session_lookup.session_file
            FROM telemetry_events AS session_lookup
            WHERE session_lookup.session_id = session_label_times.label_session_id
              AND session_lookup.timestamp = session_label_times.file_timestamp
              AND COALESCE(session_lookup.session_file, '') <> ''
            LIMIT 1
          ) AS resolved_session_file
        FROM session_label_times
      )
    `,
    fromSql: `${eventSource}
      LEFT JOIN session_labels
        ON session_labels.label_session_id = telemetry_events.session_id`,
  };
}

export function queryTokenUsageAggregate(options: TokenUsageQueryOptions = {}) {
  flushTokenTelemetryEvents(options.agentDir || "");
  const db = openTokenUsageDb(options.agentDir || "");
  const groupBy = Array.isArray(options.groupBy) ? options.groupBy : [];
  const dims = groupBy.map((key) => ({
    key,
    ...resolveDimensionDef(key, "unsupported_group_by"),
  }));
  const { whereSql, params } = buildWhereClause(options, true);
  const sessionQuery = buildSessionLabelsQueryParts(
    options,
    queryUsesSessionLabels(options, groupBy),
    true,
  );
  const selectDims = dims.map((dim) => `${dim.select} AS "${dim.key}"`);
  const groupSql = dims.length
    ? `GROUP BY ${dims.map((dim) => dim.select).join(", ")}`
    : "";
  const orderBy = safeString(options.orderBy).trim() || "total_tokens";
  const direction =
    safeString(options.direction).trim().toLowerCase() === "asc"
      ? "ASC"
      : "DESC";
  const supportedOrder = new Set([
    ...dims.map((dim) => dim.key),
    ...AGGREGATE_ORDER_FIELDS,
  ]);
  const orderExpr = supportedOrder.has(orderBy)
    ? `"${orderBy}"`
    : `"total_tokens"`;
  const limit = clampQueryLimit(options.limit, DEFAULT_AGGREGATE_LIMIT);
  const sql = `
    ${sessionQuery.withSql}
    SELECT
      ${selectDims.length ? `${selectDims.join(",\n      ")},` : ""}
      ${AGGREGATE_METRICS.map((metric) => `${metric.select} AS ${metric.key}`).join(",\n      ")}
    FROM ${sessionQuery.fromSql}
    ${whereSql}
    ${groupSql}
    ORDER BY ${orderExpr} ${direction}
    LIMIT @limit
  `;
  return prepareCached(db, sql).all({ ...params, limit }) as any[];
}

export function queryTokenUsageEvents(options: TokenUsageQueryOptions = {}) {
  flushTokenTelemetryEvents(options.agentDir || "");
  const db = openTokenUsageDb(options.agentDir || "");
  const { whereSql, params } = buildWhereClause(options, false);
  const sessionQuery = buildSessionLabelsQueryParts(
    options,
    queryUsesSessionLabels(options),
    false,
  );
  const limit = clampQueryLimit(options.limit, DEFAULT_EVENTS_LIMIT);
  return prepareCached(
    db,
    `
      ${sessionQuery.withSql}
      SELECT
        ${RECENT_EVENT_SELECT_COLUMNS.join(",\n        ")}
      FROM ${sessionQuery.fromSql}
      ${whereSql}
      ORDER BY timestamp DESC
      LIMIT @limit
    `,
  ).all({ ...params, limit }) as any[];
}
