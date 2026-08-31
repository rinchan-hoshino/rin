import type {
  RinRpcCommandEnvelope,
  RinRpcCommandResult,
  RinRpcCommandRouter,
  RinRpcCommandType,
} from "../rin-lib/rpc-types.js";
import type { ChatBridgeHandle } from "./main.js";
import { getChatMessageRead, listChatMessageReads } from "./message-query.js";
import type { ChatMessageListWindow } from "./message-store.js";

export type ChatBridgeCommandPort = Pick<
  ChatBridgeHandle,
  "send" | "runTurn" | "typing" | "react" | "terminateTurn" | "evalBridge"
>;

export type ChatDaemonDeliveryPort = Pick<
  ChatBridgeCommandPort,
  "send" | "runTurn" | "typing" | "react" | "terminateTurn"
>;

export type ChatDaemonIntegration = {
  delivery: ChatDaemonDeliveryPort;
  commandRouter: RinRpcCommandRouter;
};

type ChatDaemonRpcHandler = (
  command: RinRpcCommandEnvelope,
) => Promise<RinRpcCommandResult> | RinRpcCommandResult;

function isCommandEnvelope(value: unknown): value is RinRpcCommandEnvelope {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function commandPayload<T>(command: RinRpcCommandEnvelope): T {
  return (command.payload || {}) as T;
}

function success(data: unknown): RinRpcCommandResult {
  return { success: true, data };
}

export function createChatDaemonIntegration(options: {
  agentDir: string;
  getBridge: () => Promise<ChatBridgeCommandPort>;
}): ChatDaemonIntegration {
  const delivery: ChatDaemonDeliveryPort = {
    send: async (payload, sendOptions) =>
      await (await options.getBridge()).send(payload, sendOptions),
    runTurn: async (payload) =>
      await (await options.getBridge()).runTurn(payload),
    typing: async (payload) =>
      await (await options.getBridge()).typing(payload),
    react: async (payload) => await (await options.getBridge()).react(payload),
    terminateTurn: async (payload) =>
      await (await options.getBridge()).terminateTurn(payload),
  };

  const handlers = {
    chat_send: async (command) =>
      success(await delivery.send(commandPayload(command))),
    chat_run_turn: async (command) =>
      success(await delivery.runTurn(commandPayload(command))),
    chat_typing: async (command) =>
      success(await delivery.typing(commandPayload(command))),
    chat_react: async (command) =>
      success(await delivery.react(commandPayload(command))),
    chat_terminate_turn: async (command) =>
      success(await delivery.terminateTurn(commandPayload(command))),
    chat_message_get: (command) => {
      const payload = commandPayload<Record<string, unknown>>(command);
      return success(
        getChatMessageRead(
          options.agentDir,
          String(payload.chatKey || ""),
          String(payload.messageId || ""),
        ) || null,
      );
    },
    chat_message_list: (command) =>
      success(
        listChatMessageReads(
          options.agentDir,
          commandPayload<ChatMessageListWindow>(command),
        ),
      ),
    chat_bridge_eval: async (command) =>
      success(
        await (await options.getBridge()).evalBridge(commandPayload(command)),
      ),
  } satisfies Partial<Record<RinRpcCommandType, ChatDaemonRpcHandler>>;

  const commandRouter: RinRpcCommandRouter = async (command) => {
    if (!isCommandEnvelope(command)) return undefined;
    const type = String(command.type || "").trim() as keyof typeof handlers;
    const handler = handlers[type];
    return handler ? await handler(command) : undefined;
  };

  return { delivery, commandRouter };
}
