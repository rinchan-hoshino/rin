import {
  canConnectDaemonSocket,
  requestDaemonCommand,
} from "../rin-daemon/client.js";
import { RIN_MEMORY_PROVIDER_TIMEOUTS_V1 } from "../rin-extension-api/index.js";
import { createMemoryCoordinator } from "./coordinator.js";
import type { TranscriptArchiveEntry } from "./transcript-types.js";

const MEMORY_CONNECT_TIMEOUT_MS = 200;
const MEMORY_COMMAND_GRACE_MS = 500;

type MemoryProviderClientOptions = {
  commandTimeoutMs?: number;
  socketPath?: string;
};

type DaemonMemoryCommandResult =
  | { available: false }
  | { available: true; response: unknown };

function commandTimeoutMs(configured: number | undefined, fallback: number) {
  return Number.isFinite(configured) && Number(configured) > 0
    ? Number(configured)
    : fallback;
}

async function daemonMemoryCommand(
  command: Record<string, any>,
  timeoutMs: number,
  socketPath?: string,
): Promise<DaemonMemoryCommandResult> {
  if (!(await canConnectDaemonSocket(socketPath, MEMORY_CONNECT_TIMEOUT_MS))) {
    return { available: false };
  }
  return {
    available: true,
    response: await requestDaemonCommand(command, { timeoutMs, socketPath }),
  };
}

function normalizeRecallResponse(value: unknown) {
  const response = value as {
    results?: unknown;
    totalResults?: unknown;
  };
  const results = Array.isArray(response?.results) ? response.results : [];
  const totalResults = Number(response?.totalResults);
  return {
    results,
    totalResults: Number.isFinite(totalResults) ? totalResults : results.length,
  };
}

export async function searchMemoryProviders(
  params: Record<string, unknown>,
  agentDir: string,
  options: MemoryProviderClientOptions = {},
) {
  let daemonResult: DaemonMemoryCommandResult;
  try {
    daemonResult = await daemonMemoryCommand(
      { type: "memory_search_providers", payload: params },
      commandTimeoutMs(
        options.commandTimeoutMs,
        RIN_MEMORY_PROVIDER_TIMEOUTS_V1.searchMs + MEMORY_COMMAND_GRACE_MS,
      ),
      options.socketPath,
    );
  } catch {
    return { results: [], totalResults: 0 };
  }
  if (daemonResult.available)
    return normalizeRecallResponse(daemonResult.response);
  return await createMemoryCoordinator({ agentDir }).recall(params);
}

export async function writeMemoryEntry(
  entry: TranscriptArchiveEntry,
  agentDir: string,
  options: MemoryProviderClientOptions = {},
) {
  let daemonResult: DaemonMemoryCommandResult;
  try {
    daemonResult = await daemonMemoryCommand(
      { type: "memory_write_providers", payload: entry },
      commandTimeoutMs(
        options.commandTimeoutMs,
        RIN_MEMORY_PROVIDER_TIMEOUTS_V1.writeMs + MEMORY_COMMAND_GRACE_MS,
      ),
      options.socketPath,
    );
  } catch {
    return { localIncluded: false, operationCount: 0, fulfilled: 0 };
  }
  if (daemonResult.available) return daemonResult.response;
  return await createMemoryCoordinator({ agentDir }).write(entry);
}
