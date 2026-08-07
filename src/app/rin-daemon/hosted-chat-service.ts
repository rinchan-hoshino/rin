import type {
  ChatBridgeHandle,
  ChatBridgeStatus,
} from "../../core/chat/main.js";
import { safeString } from "../../core/text-utils.js";

type HostedChatStatus =
  | ChatBridgeStatus
  | {
      ready: false;
      status: "starting" | "degraded" | "stopped";
      error?: string;
      retrying?: true;
      retryAttempt?: number;
    };

type HostedChatRetryOptions = {
  initialDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  isRetryable?: (error: string) => boolean;
};

const TRANSIENT_CHAT_STARTUP_ERROR_RE =
  /(?:^|:)(?:rin_timeout|rin_disconnected|daemon_timeout)(?::|$)|\b(?:ECONNABORTED|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETDOWN|ENETUNREACH|EPIPE|ETIMEDOUT)\b|\bfetch failed\b|\bnetwork error\b/i;

function isTransientChatStartupError(error: string): boolean {
  return TRANSIENT_CHAT_STARTUP_ERROR_RE.test(error);
}

function finiteNumber(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

export type HostedChatService = {
  start: (factory: () => Promise<ChatBridgeHandle>) => Promise<void>;
  stop: () => Promise<void>;
  getBridge: () => Promise<ChatBridgeHandle>;
  getStatus: () => HostedChatStatus;
};

export function createHostedChatService(
  options: {
    logger?: Pick<Console, "error">;
    retry?: HostedChatRetryOptions;
  } = {},
): HostedChatService {
  const logger = options.logger || console;
  const initialDelayMs = Math.max(
    1,
    finiteNumber(options.retry?.initialDelayMs, 1_000),
  );
  const maxDelayMs = Math.max(
    initialDelayMs,
    finiteNumber(options.retry?.maxDelayMs, 60_000),
  );
  const jitterRatio = Math.min(
    1,
    Math.max(0, finiteNumber(options.retry?.jitterRatio, 0.2)),
  );
  const isRetryable = options.retry?.isRetryable || isTransientChatStartupError;

  let bridge: ChatBridgeHandle | null = null;
  let startupError = "";
  let state: "starting" | "ready" | "degraded" | "stopped" = "starting";
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let startupFactory: (() => Promise<ChatBridgeHandle>) | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let retryAttempt = 0;
  let retrying = false;
  let stopping = false;

  const retryDelayMs = (attempt: number): number => {
    const exponential = Math.min(
      maxDelayMs,
      initialDelayMs * 2 ** Math.max(0, attempt - 1),
    );
    const jitter = 1 + (Math.random() * 2 - 1) * jitterRatio;
    return Math.max(1, Math.round(exponential * jitter));
  };

  const scheduleRetry = (delayMs: number) => {
    if (stopping || retryTimer || !startupFactory) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void runStartupAttempt();
    }, delayMs);
    retryTimer.unref?.();
  };

  async function runStartupAttempt() {
    if (stopping || bridge || !startupFactory) return;
    if (startPromise) return await startPromise;

    const factory = startupFactory;
    const attemptPromise = (async () => {
      try {
        const startedBridge = await factory();
        if (stopping) {
          await startedBridge.stop().catch(() => {});
          return;
        }
        bridge = startedBridge;
        startupError = "";
        retryAttempt = 0;
        retrying = false;
        state = "ready";
      } catch (error: any) {
        if (stopping) return;
        startupError =
          safeString(error?.message || error).trim() || "chat_start_failed";
        state = "degraded";
        retryAttempt += 1;
        retrying = isRetryable(startupError);
        const delayMs = retrying ? retryDelayMs(retryAttempt) : 0;
        logger.error(
          `rin_app_daemon_chat_degraded:${startupError}${retrying ? ` retryAttempt=${retryAttempt} retryInMs=${delayMs}` : ""}`,
        );
        if (retrying) scheduleRetry(delayMs);
      }
    })();
    startPromise = attemptPromise;
    try {
      await attemptPromise;
    } finally {
      if (startPromise === attemptPromise) startPromise = null;
    }
  }

  const start = async (factory: () => Promise<ChatBridgeHandle>) => {
    startupFactory ||= factory;
    await runStartupAttempt();
  };

  const getBridge = async () => {
    if (startPromise) await startPromise;
    if (bridge) return bridge;
    throw new Error(
      `chat_bridge_unavailable:${startupError || (state === "starting" ? "starting" : state)}`,
    );
  };

  const stop = async () => {
    if (!stopPromise) {
      stopping = true;
      retrying = false;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      stopPromise = (async () => {
        if (startPromise) await startPromise;
        const activeBridge = bridge;
        bridge = null;
        await activeBridge?.stop().catch(() => {});
        state = "stopped";
      })();
    }
    await stopPromise;
  };

  const getStatus = (): HostedChatStatus => {
    if (bridge) return bridge.getStatus();
    return {
      ready: false,
      status: state === "ready" ? "starting" : state,
      ...(startupError ? { error: startupError } : {}),
      ...(retrying ? { retrying: true, retryAttempt } : {}),
    };
  };

  return { start, stop, getBridge, getStatus };
}
