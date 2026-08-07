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
