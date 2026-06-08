import {
  type ChatOutboxItem,
  listChatOutboxItems,
  writeChatOutboxItem,
} from "../rin-lib/chat-outbox.js";
import { createRinI18n } from "../i18n.js";
import { DEFAULT_LANGUAGE_TAG } from "../language.js";
import { RIN_NON_INTERACTIVE_COMMAND_NAMES } from "../rin-frontend-sdk/index.js";
import { markProcessedChatMessage, safeString } from "./chat-helpers.js";
import { sendOutboxPayload } from "./transport.js";

export type ChatCommandRow = {
  name: string;
  description?: string;
};

let chatOutboxDrainQueue: Promise<void> = Promise.resolve();

export function getChatCommandRows(
  languageTag = DEFAULT_LANGUAGE_TAG,
): ChatCommandRow[] {
  const descriptions = createRinI18n(languageTag).chatCommandDescriptions;
  return RIN_NON_INTERACTIVE_COMMAND_NAMES.map((name) => ({
    name,
    description: descriptions[name],
  }));
}

function normalizeTelegramCommandName(value: unknown) {
  const rawName = safeString(value).trim();
  if (!/^[\w-]{1,32}$/.test(rawName)) return "";
  return rawName.toLowerCase().replace(/[^\w]/g, "_");
}

function createTelegramCommandEntry(item: ChatCommandRow | undefined) {
  const rawName = safeString(item?.name).trim();
  const command = normalizeTelegramCommandName(rawName);
  if (!command) return null;
  return {
    command,
    description: safeString(item?.description).trim() || rawName,
  };
}

export function buildTelegramCommandPayload(commandRows: ChatCommandRow[]) {
  const payload: Array<{ command: string; description: string }> = [];
  const seen = new Set<string>();

  for (const item of commandRows) {
    const entry = createTelegramCommandEntry(item);
    if (!entry || seen.has(entry.command)) continue;
    payload.push(entry);
    seen.add(entry.command);
  }

  return payload;
}

export function buildTelegramCommandClearScopes() {
  return [
    { type: "all_private_chats" },
    { type: "all_group_chats" },
    { type: "all_chat_administrators" },
  ];
}

async function syncTelegramCommandsViaInternal(
  bot: any,
  payload: Array<{ command: string; description: string }>,
  clearScopes: Array<{ type: string }>,
) {
  if (typeof bot?.internal?.setMyCommands !== "function") return false;
  if (typeof bot?.internal?.deleteMyCommands === "function") {
    for (const scope of clearScopes) {
      await bot.internal.deleteMyCommands({ scope });
    }
  }
  if (payload.length) {
    await bot.internal.setMyCommands({ commands: payload });
  }
  return true;
}

async function syncTelegramCommandsForBot(
  bot: any,
  commander: any,
  payload: Array<{ command: string; description: string }>,
  clearScopes: Array<{ type: string }>,
) {
  if (await syncTelegramCommandsViaInternal(bot, payload, clearScopes)) {
    return;
  }
  if (commander?.updateCommands && typeof bot?.updateCommands === "function") {
    await commander.updateCommands(bot);
  }
}

function warnTelegramCommandSyncFailure(logger: any, bot: any, error: unknown) {
  logger.warn(
    `chat command sync failed platform=${safeString(bot?.platform)} selfId=${safeString(bot?.selfId)} err=${safeString((error as any)?.message || error)}`,
  );
}

export async function syncTelegramCommands(
  app: any,
  logger: any,
  commandRows: ChatCommandRow[] = [],
) {
  const commander = app.$commander;
  const payload = buildTelegramCommandPayload(commandRows);
  const clearScopes = buildTelegramCommandClearScopes();

  for (const bot of Array.isArray(app.bots) ? app.bots : []) {
    if (safeString(bot?.platform) !== "telegram") continue;

    try {
      await syncTelegramCommandsForBot(bot, commander, payload, clearScopes);
    } catch (error: any) {
      warnTelegramCommandSyncFailure(logger, bot, error);
    }
  }
}

const CHAT_OUTBOX_MAX_ATTEMPTS = 4;
const CHAT_OUTBOX_RETRY_DELAYS_MS = [1000, 3000, 10_000] as const;

function chatOutboxErrorMessage(error: unknown) {
  return safeString((error as any)?.message || error) || "send_failed";
}

function isPermanentChatOutboxError(error: unknown) {
  const message = chatOutboxErrorMessage(error);
  return (
    /^(invalid_chatKey|no_bot_for_platform|chat_outbox_empty_message|chat_outbox_invalid_part|unsupported_chat_part|chat_part_file_missing|chat_media_file_missing)\b/.test(
      message,
    ) ||
    /\b(?:forbidden|blocked|bot was kicked|chat not found|recipient not found|not enough rights|message thread not found)\b/i.test(
      message,
    )
  );
}

function nextRetryAt(attempts: number) {
  const delayMs =
    CHAT_OUTBOX_RETRY_DELAYS_MS[
      Math.min(
        Math.max(0, attempts - 1),
        CHAT_OUTBOX_RETRY_DELAYS_MS.length - 1,
      )
    ] || CHAT_OUTBOX_RETRY_DELAYS_MS[CHAT_OUTBOX_RETRY_DELAYS_MS.length - 1];
  return new Date(Date.now() + delayMs).toISOString();
}

function isRetryDue(item: ChatOutboxItem) {
  const nextAttemptAt = safeString(item.nextAttemptAt).trim();
  if (!nextAttemptAt) return true;
  const dueAt = Date.parse(nextAttemptAt);
  return !Number.isFinite(dueAt) || dueAt <= Date.now();
}

function warnChatOutboxFailure(
  logger: any,
  item: ChatOutboxItem,
  error: unknown,
  status: "queued" | "failed",
) {
  logger.warn(
    `chat outbox ${status} id=${item.id} chatKey=${safeString(item.payload?.chatKey)} attempts=${item.attempts} err=${chatOutboxErrorMessage(error)}`,
  );
}

function applyPostDelivery(agentDir: string, item: ChatOutboxItem) {
  const markProcessed = item.postDelivery?.markProcessed;
  const messageId = safeString(markProcessed?.messageId).trim();
  const chatKey = safeString(
    markProcessed?.chatKey || item.payload?.chatKey,
  ).trim();
  if (!messageId || !chatKey) return;
  const bindSession = markProcessed?.bindSession !== false;
  markProcessedChatMessage(agentDir, chatKey, messageId, {
    ...(bindSession
      ? { sessionFile: markProcessed?.sessionFile || item.payload?.sessionFile }
      : {}),
    acceptedAt: new Date().toISOString(),
    processedAt: new Date().toISOString(),
  });
}

async function drainChatOutboxItem(
  app: any,
  agentDir: string,
  h: any,
  logger: any,
  item: ChatOutboxItem,
) {
  if (item.status === "delivered" || item.status === "failed") {
    return { status: item.status };
  }
  if (!isRetryDue(item)) {
    return { status: "deferred" as const };
  }
  const sending: ChatOutboxItem = {
    ...item,
    status: "sending",
    attempts: item.attempts + 1,
    updatedAt: new Date().toISOString(),
  };
  writeChatOutboxItem(agentDir, sending);
  try {
    const deliveryResult = await sendOutboxPayload(
      app,
      agentDir,
      sending.payload,
      h,
    );
    const delivered: ChatOutboxItem = {
      ...sending,
      status: "delivered",
      updatedAt: new Date().toISOString(),
      deliveredAt: new Date().toISOString(),
      deliveryResult,
      lastError: undefined,
      nextAttemptAt: undefined,
      failureKind: undefined,
    };
    writeChatOutboxItem(agentDir, delivered);
    applyPostDelivery(agentDir, delivered);
    return {
      status: "delivered" as const,
      deliveryResult,
    };
  } catch (error: any) {
    const message = chatOutboxErrorMessage(error);
    const permanent = isPermanentChatOutboxError(error);
    const exhausted = sending.attempts >= CHAT_OUTBOX_MAX_ATTEMPTS;
    if (permanent || exhausted) {
      const failed: ChatOutboxItem = {
        ...sending,
        status: "failed",
        updatedAt: new Date().toISOString(),
        failedAt: new Date().toISOString(),
        lastError: message,
        nextAttemptAt: undefined,
        failureKind: permanent ? "permanent" : "attempts_exhausted",
      };
      writeChatOutboxItem(agentDir, failed);
      warnChatOutboxFailure(logger, failed, error, "failed");
      return {
        status: "failed" as const,
        error: message,
      };
    }
    const queued: ChatOutboxItem = {
      ...sending,
      status: "queued",
      updatedAt: new Date().toISOString(),
      lastError: message,
      nextAttemptAt: nextRetryAt(sending.attempts),
      failureKind: "retryable",
    };
    writeChatOutboxItem(agentDir, queued);
    warnChatOutboxFailure(logger, queued, error, "queued");
    return {
      status: "queued" as const,
      error: message,
    };
  }
}

async function drainChatOutboxNow(
  app: any,
  agentDir: string,
  h: any,
  logger: any,
) {
  const results: Array<{ id: string; status?: string }> = [];
  for (const { item } of listChatOutboxItems(agentDir)) {
    if (item.status === "delivered" || item.status === "failed") continue;
    if (!isRetryDue(item)) continue;
    const result = await drainChatOutboxItem(app, agentDir, h, logger, item);
    results.push({ id: item.id, ...(result || {}) });
  }
  return results;
}

export async function drainChatOutbox(
  app: any,
  agentDir: string,
  h: any,
  logger: any,
) {
  const previous = chatOutboxDrainQueue;
  let release!: () => void;
  const slot = new Promise<void>((resolve) => {
    release = resolve;
  });
  chatOutboxDrainQueue = previous.then(
    () => slot,
    () => slot,
  );
  await previous.catch(() => {});
  try {
    return await drainChatOutboxNow(app, agentDir, h, logger);
  } finally {
    release();
  }
}
