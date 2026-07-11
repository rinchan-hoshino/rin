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

async function settleWithin<T>(operation: () => Promise<T>, timeoutMs: number) {
  return await new Promise<
    { completed: true; value?: T; error?: unknown } | { completed: false }
  >((resolve) => {
    let settled = false;
    const finish = (
      result:
        | { completed: true; value?: T; error?: unknown }
        | { completed: false },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ completed: false }),
      Math.max(1, timeoutMs),
    );
    Promise.resolve()
      .then(operation)
      .then(
        (value) => finish({ completed: true, value }),
        (error) => finish({ completed: true, error }),
      );
  });
}

export async function captureDaemonRestartSnapshot(options: {
  queryStatus: DaemonStatusProvider;
  canConnect: () => Promise<boolean>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  operationTimeoutMs?: number;
  absenceConfirmMs?: number;
}) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(0, Number(options.timeoutMs))
    : 5_000;
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs)
    ? Math.max(10, Number(options.pollIntervalMs))
    : 200;
  const operationTimeoutMs = Number.isFinite(options.operationTimeoutMs)
    ? Math.max(1, Number(options.operationTimeoutMs))
    : 2_000;
  const absenceConfirmMs = Number.isFinite(options.absenceConfirmMs)
    ? Math.max(0, Number(options.absenceConfirmMs))
    : 500;
  const deadline = Date.now() + timeoutMs;
  const remainingOrThrow = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("rin_daemon_restart_snapshot_unavailable");
    }
    return remaining;
  };
  const assertWithinDeadline = () => {
    if (Date.now() >= deadline) {
      throw new Error("rin_daemon_restart_snapshot_unavailable");
    }
  };
  let absentSince: number | null = null;
  let absentProbeCount = 0;
  for (;;) {
    const query = await settleWithin(
      options.queryStatus,
      Math.min(operationTimeoutMs, remainingOrThrow()),
    );
    assertWithinDeadline();
    const statusResponded =
      query.completed && !query.error && query.value != null;
    if (statusResponded && daemonChatStartedAt(query.value)) {
      return snapshotDaemonRestart(query.value, true);
    }
    if (statusResponded) {
      absentSince = null;
      absentProbeCount = 0;
      await sleep(Math.min(pollIntervalMs, remainingOrThrow()));
      continue;
    }

    const probe = await settleWithin(
      options.canConnect,
      Math.min(operationTimeoutMs, remainingOrThrow()),
    );
    assertWithinDeadline();
    if (probe.completed && !probe.error && probe.value === false) {
      absentSince ??= Date.now();
      absentProbeCount += 1;
      if (
        absentProbeCount >= 2 &&
        Date.now() - absentSince >= absenceConfirmMs
      ) {
        return snapshotDaemonRestart(undefined, false);
      }
    } else if (probe.completed && !probe.error && probe.value === true) {
      absentSince = null;
      absentProbeCount = 0;
    }

    await sleep(Math.min(pollIntervalMs, remainingOrThrow()));
  }
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
