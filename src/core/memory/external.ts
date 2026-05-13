import {
  canConnectDaemonSocket,
  requestDaemonCommand,
} from "../rin-daemon/client.js";
import { safeString } from "./utils.js";
import {
  normalizeExternalMemoryLimit,
  normalizeExternalMemoryResults,
} from "./external-results.js";
import type {
  ExternalMemoryResult,
  TranscriptArchiveEntry,
} from "./transcript-types.js";

const EXTERNAL_MEMORY_CONNECT_TIMEOUT_MS = 200;
const EXTERNAL_MEMORY_SEARCH_TIMEOUT_MS = 30_000;
const EXTERNAL_MEMORY_WRITE_TIMEOUT_MS = 5_000;

async function daemonMemoryCommand(
  command: Record<string, any>,
  timeoutMs: number,
) {
  if (
    !(await canConnectDaemonSocket(
      undefined,
      EXTERNAL_MEMORY_CONNECT_TIMEOUT_MS,
    ))
  ) {
    return undefined;
  }
  return await requestDaemonCommand(command, { timeoutMs });
}

export async function searchExternalMemoryProviders(
  query: string,
  params: Record<string, unknown> = {},
): Promise<ExternalMemoryResult[]> {
  try {
    const limit = normalizeExternalMemoryLimit(params.limit, 8);
    const response = await daemonMemoryCommand(
      {
        type: "memory_search_external",
        payload: {
          ...params,
          query: safeString(query).trim(),
          limit,
        },
      },
      EXTERNAL_MEMORY_SEARCH_TIMEOUT_MS,
    );
    return normalizeExternalMemoryResults(response, { startScore: limit });
  } catch {
    return [];
  }
}

export async function writeExternalMemoryEntry(
  entry: TranscriptArchiveEntry,
): Promise<void> {
  try {
    await daemonMemoryCommand(
      {
        type: "memory_write_external",
        payload: entry,
      },
      EXTERNAL_MEMORY_WRITE_TIMEOUT_MS,
    );
  } catch {}
}
