import { asArray } from "../json-utils.js";
import { safeString } from "./chat-helpers.js";

type TerminalLedgerClient = {
  isConnected: () => boolean;
  connect: () => Promise<unknown>;
  request: <T>(command: Record<string, unknown>) => Promise<T>;
  disconnect: () => Promise<void>;
};

type TerminalRecoveryController = {
  connect: () => Promise<unknown>;
  driver: {
    handleClientEvent: (event: unknown) => Promise<void>;
  };
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

export async function reconcileChatTerminalEvents(
  terminals: Record<string, unknown>[],
  getController: (chatKey: string) => TerminalRecoveryController,
) {
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const terminal of terminals) {
    const context = terminal?.chatDeliveryContext as
      | Record<string, unknown>
      | undefined;
    const chatKey = safeString(context?.chatKey).trim();
    if (!chatKey) continue;
    const events = grouped.get(chatKey) || [];
    events.push(terminal);
    grouped.set(chatKey, events);
  }
  for (const [chatKey, events] of grouped) {
    const controller = getController(chatKey);
    await controller.connect();
    for (const terminal of events) {
      await controller.driver.handleClientEvent({
        type: "ui",
        payload: terminal,
      });
    }
  }
  return [...grouped.keys()];
}
