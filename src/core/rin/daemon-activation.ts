import { sleep } from "../platform/process.js";

export type DaemonStatusProvider = () => Promise<any | undefined>;

export function daemonChatStartedAt(status: any) {
  const resolved = status?.data ?? status;
  return String(resolved?.chat?.startedAt || "").trim();
}

export function snapshotDaemonRestart(status: any, daemonRunning: boolean) {
  if (!daemonRunning) {
    return { previousChatStartedAt: "", requireNewGeneration: false };
  }
  const previousChatStartedAt = daemonChatStartedAt(status);
  if (!previousChatStartedAt) {
    throw new Error("rin_daemon_restart_snapshot_unavailable");
  }
  return { previousChatStartedAt, requireNewGeneration: true };
}

export function isActivatedDaemonStatus(
  status: any,
  previousChatStartedAt = "",
  requireNewGeneration = false,
) {
  const chat = status?.chat;
  if (!chat || chat.ready !== true || chat.stopping === true) return false;
  const previous = String(previousChatStartedAt || "").trim();
  if (!previous) return !requireNewGeneration;
  const current = daemonChatStartedAt(status);
  return Boolean(current && current !== previous);
}

export async function waitForActivatedDaemon(
  queryStatus: DaemonStatusProvider,
  options: {
    previousChatStartedAt?: string;
    requireNewGeneration?: boolean;
    timeoutMs?: number;
    pollIntervalMs?: number;
  } = {},
) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(0, Number(options.timeoutMs))
    : 30_000;
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs)
    ? Math.max(10, Number(options.pollIntervalMs))
    : 200;
  const deadline = Date.now() + timeoutMs;
  let lastStatus: any = null;
  for (;;) {
    try {
      const response = await queryStatus();
      lastStatus = response?.data || response;
      if (
        isActivatedDaemonStatus(
          lastStatus,
          options.previousChatStartedAt,
          options.requireNewGeneration,
        )
      ) {
        return { activated: true as const, status: lastStatus };
      }
    } catch {
      lastStatus = null;
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(pollIntervalMs, Math.max(10, deadline - Date.now())));
  }
  return { activated: false as const, status: lastStatus };
}

export async function activateDaemonRestart<T>(options: {
  previousChatStartedAt?: string;
  requireNewGeneration?: boolean;
  restart: () => Promise<T>;
  queryStatus: DaemonStatusProvider;
  timeoutMs?: number;
  activationError: string;
}) {
  const result = await options.restart();
  const activation = await waitForActivatedDaemon(options.queryStatus, {
    previousChatStartedAt: options.previousChatStartedAt,
    requireNewGeneration: options.requireNewGeneration,
    timeoutMs: options.timeoutMs,
  });
  if (!activation.activated) throw new Error(options.activationError);
  return result;
}
