import { asArray } from "../json-utils.js";
import { safeString } from "./chat-helpers.js";

type TerminalLedgerClient = {
  isConnected: () => boolean;
  connect: () => Promise<unknown>;
  request: <T>(command: Record<string, unknown>) => Promise<T>;
  disconnect: () => Promise<void>;
};

export async function listUnacknowledgedChatTerminalEvents(
  client: TerminalLedgerClient,
) {
  try {
    if (!client.isConnected()) await client.connect();
    const data = await client.request<{ terminals?: unknown[] }>({
      type: "list_unacknowledged_chat_terminals",
    });
    return asArray(data?.terminals) as Record<string, unknown>[];
  } catch (error) {
    await client.disconnect().catch(() => {});
    throw error;
  }
}

export async function projectAndAcknowledgeChatTerminalEvent(
  client: TerminalLedgerClient,
  terminal: Record<string, unknown>,
  projectTerminal: () => Promise<void>,
) {
  await projectTerminal();
  const requestTag = safeString(terminal?.requestTag).trim();
  const terminalRecord = terminal?.terminalRecord as
    | Record<string, unknown>
    | undefined;
  const terminalId = safeString(terminalRecord?.terminalId).trim();
  if (!requestTag || !terminalId) {
    throw new Error("chat_terminal_record_missing");
  }
  try {
    if (!client.isConnected()) await client.connect();
    await client.request({
      type: "ack_turn_terminal",
      requestTag,
      terminalId,
    });
  } catch (error) {
    await client.disconnect().catch(() => {});
    throw error;
  }
}

export async function reconcileChatTerminalEvents(
  terminals: Record<string, unknown>[],
  handleTerminal: (
    chatKey: string,
    terminal: Record<string, unknown>,
  ) => Promise<void>,
) {
  let handled = 0;
  for (const terminal of terminals) {
    const requestTag = safeString(terminal?.requestTag).trim();
    if (!requestTag.startsWith("chat-inbox-")) continue;
    const context = terminal?.chatDeliveryContext as
      | Record<string, unknown>
      | undefined;
    const chatKey = safeString(context?.chatKey).trim();
    if (!chatKey) continue;
    await handleTerminal(chatKey, terminal);
    handled += 1;
  }
  return handled;
}

export function createChatTerminalReconciliationLoop(options: {
  client: TerminalLedgerClient | null;
  isStopping: () => boolean;
  controllers: Map<string, any>;
  detachedControllers: Map<string, any>;
  detachedControllerSignatures: Map<string, string>;
  getDetachedController: (
    controllerKey: string,
    options: {
      chatKey: string;
      affectChatBinding: boolean;
      useChatFrontendIdentity: boolean;
    },
  ) => any;
  logger: { info: (message: string) => void; warn: (message: string) => void };
}) {
  let listInFlight: Promise<void> | null = null;
  const projectionInFlight = new Set<string>();

  const request = () => {
    if (options.isStopping() || listInFlight || !options.client) {
      return listInFlight;
    }
    const client = options.client;
    listInFlight = (async () => {
      const terminals = await listUnacknowledgedChatTerminalEvents(client);
      let scheduled = 0;
      await reconcileChatTerminalEvents(
        terminals,
        async (chatKey, terminal) => {
          const terminalRecord = terminal?.terminalRecord as
            | Record<string, unknown>
            | undefined;
          const terminalId = safeString(
            terminalRecord?.terminalId ||
              terminal?.chatTerminalRecordId ||
              terminal?.terminalId,
          ).trim();
          if (!terminalId || projectionInFlight.has(terminalId)) return;
          projectionInFlight.add(terminalId);
          scheduled += 1;
          void (async () => {
            const activeController = options.controllers.get(chatKey);
            if (
              activeController?.ownsAuthoritativeTerminalProjection(terminal)
            ) {
              await projectAndAcknowledgeChatTerminalEvent(
                client,
                terminal,
                async () => {
                  await activeController.driver.projectAuthoritativeTerminal(
                    terminal,
                  );
                },
              );
              return;
            }
            const controllerKey = `terminal-reconcile:${terminalId}`;
            const controller = options.getDetachedController(controllerKey, {
              chatKey,
              affectChatBinding: false,
              useChatFrontendIdentity: false,
            });
            try {
              await controller.connect({
                restoreSession: false,
                recoverTerminals: false,
              });
              await projectAndAcknowledgeChatTerminalEvent(
                client,
                terminal,
                async () => {
                  await controller.driver.projectAuthoritativeTerminal(
                    terminal,
                  );
                },
              );
            } finally {
              controller.dispose();
              options.detachedControllers.delete(controllerKey);
              options.detachedControllerSignatures.delete(controllerKey);
            }
          })()
            .catch((error) => {
              options.logger.warn(
                `chat terminal projection failed terminalId=${terminalId} err=${safeString(
                  (error as Error)?.message || error,
                )}`,
              );
            })
            .finally(() => {
              projectionInFlight.delete(terminalId);
            });
        },
      );
      if (scheduled) {
        options.logger.info(
          `chat terminal reconciliation scheduled projections=${scheduled}`,
        );
      }
    })()
      .catch((error) => {
        options.logger.warn(
          `chat terminal reconciliation failed err=${safeString(
            (error as Error)?.message || error,
          )}`,
        );
      })
      .finally(() => {
        listInFlight = null;
      });
    return listInFlight;
  };

  return { request };
}
