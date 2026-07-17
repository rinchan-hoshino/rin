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
    };

export type HostedChatService = {
  start: (factory: () => Promise<ChatBridgeHandle>) => Promise<void>;
  stop: () => Promise<void>;
  getBridge: () => Promise<ChatBridgeHandle>;
  getStatus: () => HostedChatStatus;
};

export function createHostedChatService(
  options: {
    logger?: Pick<Console, "error">;
  } = {},
): HostedChatService {
  const logger = options.logger || console;
  let bridge: ChatBridgeHandle | null = null;
  let startupError = "";
  let state: "starting" | "ready" | "degraded" | "stopped" = "starting";
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;

  const start = async (factory: () => Promise<ChatBridgeHandle>) => {
    if (!startPromise) {
      startPromise = (async () => {
        try {
          bridge = await factory();
          state = "ready";
        } catch (error: any) {
          startupError =
            safeString(error?.message || error).trim() || "chat_start_failed";
          state = "degraded";
          logger.error(`rin_app_daemon_chat_degraded:${startupError}`);
        }
      })();
    }
    await startPromise;
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
      stopPromise = (async () => {
        if (startPromise) await startPromise;
        await bridge?.stop().catch(() => {});
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
    };
  };

  return { start, stop, getBridge, getStatus };
}
