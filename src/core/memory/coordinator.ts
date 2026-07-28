import type { TranscriptArchiveEntry } from "./transcript-types.js";
import {
  appendTranscriptArchiveEntry,
  loadRecentTranscriptSessions,
  searchTranscriptArchive,
} from "./transcripts.js";
import { parseTimestampMs } from "./utils.js";

export type MemoryCapability = "search" | "recent" | "write";

export type ExtensionMemoryBridge = {
  replaces(capability: MemoryCapability): boolean;
  recall(params: Record<string, unknown>): Promise<unknown[]>;
  write(entry: TranscriptArchiveEntry): Promise<unknown>;
};

function resultTimestampMs(item: any): number {
  const direct = parseTimestampMs(item?.timestamp);
  if (direct) return direct;
  const messages = Array.isArray(item?.messages) ? item.messages : [];
  let latest = 0;
  for (const message of messages) {
    latest = Math.max(latest, parseTimestampMs(message?.timestamp));
  }
  return latest;
}

function resultScore(item: any): number {
  const score = Number(item?.score);
  return Number.isFinite(score) ? score : 0;
}

export function mergeMemoryProviderResults(
  localResults: unknown[],
  extensionResults: unknown[],
  options: { limit: number; order: "relevance" | "newest" },
) {
  const rows = [
    ...(Array.isArray(localResults) ? localResults : []),
    ...(Array.isArray(extensionResults) ? extensionResults : []),
  ];
  const ordered = rows
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const primary =
        options.order === "newest"
          ? resultTimestampMs(b.item) - resultTimestampMs(a.item)
          : resultScore(b.item) - resultScore(a.item);
      if (primary) return primary;
      const timestampDiff =
        resultTimestampMs(b.item) - resultTimestampMs(a.item);
      if (timestampDiff) return timestampDiff;
      return a.index - b.index;
    });
  const limit = Math.max(1, Number(options.limit || 8) || 8);
  return {
    results: ordered.slice(0, limit).map((row) => row.item),
    totalResults: rows.length,
  };
}

export function createMemoryCoordinator(options: {
  agentDir: string;
  extensions?: ExtensionMemoryBridge;
}) {
  return {
    async recall(params: Record<string, unknown> = {}) {
      const query = String(params.query || "").trim();
      const mode: "search" | "recent" = query ? "search" : "recent";
      const order: "relevance" | "newest" =
        query && params.order !== "newest" ? "relevance" : "newest";
      const limit = Number.isFinite(Number(params.limit))
        ? Number(params.limit)
        : 8;
      const normalizedParams = { ...params, query, order, limit };
      const includeLocal = !options.extensions?.replaces(mode);
      const [localResults, extensionResults] = await Promise.all([
        includeLocal
          ? query
            ? searchTranscriptArchive(query, normalizedParams, options.agentDir)
            : loadRecentTranscriptSessions(normalizedParams, options.agentDir)
          : Promise.resolve([]),
        options.extensions?.recall(normalizedParams) || Promise.resolve([]),
      ]);
      return mergeMemoryProviderResults(localResults, extensionResults, {
        limit,
        order,
      });
    },

    async write(entry: TranscriptArchiveEntry) {
      const includeLocal = !options.extensions?.replaces("write");
      const operations: Promise<unknown>[] = [];
      if (includeLocal) {
        operations.push(appendTranscriptArchiveEntry(entry, options.agentDir));
      }
      if (options.extensions) operations.push(options.extensions.write(entry));
      const settled = await Promise.allSettled(operations);
      return {
        localIncluded: includeLocal,
        operationCount: operations.length,
        fulfilled: settled.filter((result) => result.status === "fulfilled")
          .length,
      };
    },
  };
}
