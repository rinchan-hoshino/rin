import path from "node:path";

import { normalizeSessionValue } from "./ref.js";
import {
  ensureSessionCatalog,
  listSessionRecordFiles,
  loadSessionSummaries,
  tryListSessionCatalogPage,
  type SessionSummary,
} from "./catalog.js";

export const DEFAULT_SESSION_LIST_PAGE_LIMIT = 30;
export const MAX_SESSION_LIST_PAGE_LIMIT = 500;

export type BoundSessionPage = {
  sessions: SessionSummary[];
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
  nextOffset?: number;
};

export function normalizeSessionPageLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0)
    return DEFAULT_SESSION_LIST_PAGE_LIMIT;
  return Math.min(parsed, MAX_SESSION_LIST_PAGE_LIMIT);
}

export function normalizeSessionPageOffset(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

async function listBoundSessionPageFromFiles(options: {
  sessionDir: string;
  cwd?: string;
  offset: number;
  limit: number;
}): Promise<BoundSessionPage> {
  const resolvedCwd = normalizeSessionValue(options.cwd)
    ? path.resolve(String(options.cwd))
    : undefined;
  const files = await listSessionRecordFiles(options.sessionDir);
  const summaries = (await loadSessionSummaries(files)).filter(
    (summary) =>
      !resolvedCwd ||
      (summary.cwd ? path.resolve(summary.cwd) === resolvedCwd : false),
  );
  summaries.sort(
    (left, right) => right.modified.getTime() - left.modified.getTime(),
  );
  const total = summaries.length;
  const sessions = summaries.slice(
    options.offset,
    options.offset + options.limit,
  );
  const nextOffset = options.offset + sessions.length;
  const hasMore = nextOffset < total;

  return {
    sessions,
    offset: options.offset,
    limit: options.limit,
    total,
    hasMore,
    ...(hasMore ? { nextOffset } : {}),
  };
}

export async function listBoundSessionPage(options: {
  sessionDir: string;
  cwd?: string;
  offset?: unknown;
  limit?: unknown;
}): Promise<BoundSessionPage> {
  const offset = normalizeSessionPageOffset(options.offset);
  const limit = normalizeSessionPageLimit(options.limit);
  const catalogReady = await ensureSessionCatalog(options.sessionDir)
    .then(() => true)
    .catch(() => false);
  if (catalogReady) {
    const catalogPage = await tryListSessionCatalogPage({
      sessionDir: options.sessionDir,
      cwd: options.cwd,
      offset,
      limit,
    });
    if (catalogPage) return catalogPage;
  }
  return await listBoundSessionPageFromFiles({
    sessionDir: options.sessionDir,
    cwd: options.cwd,
    offset,
    limit,
  });
}
