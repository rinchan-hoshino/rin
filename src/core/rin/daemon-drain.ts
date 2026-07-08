import { sleep } from "../platform/process.js";

export type DaemonStatusProvider = () => Promise<any | undefined>;

export const DEFAULT_DAEMON_DRAIN_TIMEOUT_MS = 120_000;
export const DEFAULT_DAEMON_DRAIN_POLL_INTERVAL_MS = 1_000;

function asArray(value: any): any[] {
  return Array.isArray(value) ? value : [];
}

export function isDaemonStatusAvailable(status: any) {
  return Boolean(
    status && typeof status === "object" && Array.isArray(status.workers),
  );
}

export function isDaemonChatQuiescing(status: any) {
  return Boolean(
    status?.chat?.quiescing === true || status?.quiescing === true,
  );
}

export function listActiveDaemonWorkers(status: any): any[] {
  if (!isDaemonStatusAvailable(status)) return [];
  return asArray(status?.workers).filter((worker) => {
    const state = String(worker?.state || "")
      .trim()
      .toLowerCase();
    return Boolean(
      worker?.turnActive ||
      worker?.isStreaming ||
      Number(worker?.pendingResponses || 0) > 0 ||
      state === "working" ||
      state === "busy",
    );
  });
}

export function formatActiveDaemonWorkers(workers: any[]) {
  return workers
    .map((worker) => {
      const session = String(
        worker?.sessionName || worker?.sessionId || worker?.sessionFile || "",
      );
      const state = String(worker?.state || "unknown");
      return `${session || "unknown-session"}(${state})`;
    })
    .join(", ");
}

export async function waitForDaemonDrain(options: {
  queryStatus: DaemonStatusProvider;
  timeoutMs?: number;
  pollIntervalMs?: number;
  requireQuiescing?: boolean;
}) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(0, Number(options.timeoutMs))
    : DEFAULT_DAEMON_DRAIN_TIMEOUT_MS;
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs)
    ? Math.max(100, Number(options.pollIntervalMs))
    : DEFAULT_DAEMON_DRAIN_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let lastWorkers: any[] = [];
  for (;;) {
    let status: any;
    try {
      status = await options.queryStatus();
    } catch {
      return { drained: false, activeWorkers: [], statusUnavailable: true };
    }
    if (!isDaemonStatusAvailable(status)) {
      return { drained: false, activeWorkers: [], statusUnavailable: true };
    }
    if (options.requireQuiescing === true && !isDaemonChatQuiescing(status)) {
      return { drained: false, activeWorkers: [], quiesceUnavailable: true };
    }
    const activeWorkers = listActiveDaemonWorkers(status);
    if (!activeWorkers.length) return { drained: true, activeWorkers };
    lastWorkers = activeWorkers;
    if (Date.now() >= deadline) {
      return { drained: false, activeWorkers: lastWorkers };
    }
    await sleep(Math.min(pollIntervalMs, Math.max(100, deadline - Date.now())));
  }
}
