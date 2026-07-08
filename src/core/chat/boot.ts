import {
  type ChatOutboxItem,
  chatOutboxItemPath,
  listChatOutboxItems,
  readChatOutboxItem,
  writeChatOutboxItem,
} from "../rin-lib/chat-outbox.js";
import { createRinI18n } from "../i18n.js";
import { DEFAULT_LANGUAGE_TAG } from "../language.js";
import { RIN_NON_INTERACTIVE_COMMAND_NAMES } from "../rin-frontend-sdk/index.js";
import { markProcessedChatMessage, safeString } from "./chat-helpers.js";
import {
  getChatOutboxDispatchPromise,
  sendOutboxPayload,
} from "./transport.js";

export type ChatCommandRow = {
  name: string;
  description?: string;
};

const chatOutboxDrainQueues = new Map<string, Promise<void>>();

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

function normalizeDiscordCommandName(value: unknown) {
  const rawName = safeString(value).trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(rawName)) return "";
  return rawName;
}

function truncateDiscordCommandDescription(value: string) {
  return Array.from(value).slice(0, 100).join("");
}

function createDiscordCommandEntry(item: ChatCommandRow | undefined) {
  const rawName = safeString(item?.name).trim();
  const name = normalizeDiscordCommandName(rawName);
  if (!name) return null;
  return {
    name,
    description: truncateDiscordCommandDescription(
      safeString(item?.description).trim() || rawName,
    ),
    type: 1,
    options: [
      { name: "input", description: "Arguments", type: 3, required: false },
    ],
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

export function buildDiscordCommandPayload(commandRows: ChatCommandRow[]) {
  const payload: Array<{
    name: string;
    description: string;
    type: number;
    options: Array<{
      name: string;
      description: string;
      type: number;
      required: boolean;
    }>;
  }> = [];
  const seen = new Set<string>();

  for (const item of commandRows) {
    const entry = createDiscordCommandEntry(item);
    if (!entry || seen.has(entry.name)) continue;
    payload.push(entry);
    seen.add(entry.name);
  }

  return payload;
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

function warnDiscordCommandSyncFailure(logger: any, bot: any, error: unknown) {
  logger.warn(
    `chat command sync failed platform=${safeString(bot?.platform)} selfId=${safeString(bot?.selfId)} err=${safeString((error as any)?.message || error)}`,
  );
}

export async function syncDiscordCommands(
  app: any,
  logger: any,
  commandRows: ChatCommandRow[] = [],
) {
  const payload = buildDiscordCommandPayload(commandRows);

  for (const bot of Array.isArray(app.bots) ? app.bots : []) {
    if (safeString(bot?.platform) !== "discord") continue;
    if (typeof bot?.internal?.setApplicationCommands !== "function") continue;

    try {
      await bot.internal.setApplicationCommands({ commands: payload });
    } catch (error: any) {
      warnDiscordCommandSyncFailure(logger, bot, error);
    }
  }
}

const CHAT_OUTBOX_MAX_ATTEMPTS = 4;
const CHAT_OUTBOX_RETRY_DELAYS_MS = [1000, 3000, 10_000] as const;
export const DEFAULT_CHAT_OUTBOX_SEND_TIMEOUT_MS = 120_000;
export const DEFAULT_ONEBOT_MEDIA_CHAT_OUTBOX_SEND_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_CHAT_OUTBOX_DISPATCH_TIMEOUT_MS = 30_000;
export const DEFAULT_CHAT_OUTBOX_MAX_AGE_MS = 60 * 60_000;
const DEFAULT_CHAT_OUTBOX_RETRY_LEASE_MS = 5 * 60_000;

export type ChatOutboxDrainOptions = {
  chatKey?: string;
  itemId?: string;
  sendTimeoutMs?: number;
  retryLeaseMs?: number;
  maxAgeMs?: number;
};

function chatOutboxErrorMessage(error: unknown) {
  return safeString((error as any)?.message || error) || "send_failed";
}

function partialDeliveryMessageIds(error: unknown) {
  return Array.isArray((error as any)?.deliveredMessageIds)
    ? (error as any).deliveredMessageIds
        .map((item: unknown) => safeString(item).trim())
        .filter(Boolean)
    : [];
}

function isPartialChatDeliveryError(error: unknown) {
  return (
    (error as any)?.partialDelivery === true ||
    partialDeliveryMessageIds(error).length > 0 ||
    /^chat_delivery_partial\b/.test(chatOutboxErrorMessage(error))
  );
}

function isPermanentChatOutboxError(error: unknown) {
  const message = chatOutboxErrorMessage(error);
  return (
    isPartialChatDeliveryError(error) ||
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

function isRetryDue(item: ChatOutboxItem, nowMs = Date.now()) {
  const nextAttemptAt = safeString(item.nextAttemptAt).trim();
  if (!nextAttemptAt) return true;
  const dueAt = Date.parse(nextAttemptAt);
  return !Number.isFinite(dueAt) || dueAt <= nowMs;
}

function normalizePositiveMilliseconds(value: unknown, fallback: number) {
  const next = Number(value);
  if (!Number.isFinite(next) || next <= 0) return fallback;
  return Math.max(1, Math.floor(next));
}

function chatOutboxPayloadContainsMedia(payload: ChatOutboxItem["payload"]) {
  return (payload?.parts || []).some((part: any) =>
    ["image", "file", "video", "audio", "sticker"].includes(
      safeString(part?.type).trim().toLowerCase(),
    ),
  );
}

function isOneBotMediaOutboxItem(item?: Pick<ChatOutboxItem, "payload">) {
  return (
    safeString(item?.payload?.chatKey).startsWith("onebot/") &&
    chatOutboxPayloadContainsMedia(item?.payload)
  );
}

export function getChatOutboxSendTimeoutMs(
  item?: Pick<ChatOutboxItem, "payload">,
  options: ChatOutboxDrainOptions = {},
) {
  const configured =
    options.sendTimeoutMs ?? process.env.RIN_CHAT_OUTBOX_SEND_TIMEOUT_MS;
  if (configured !== undefined) {
    return normalizePositiveMilliseconds(
      configured,
      DEFAULT_CHAT_OUTBOX_SEND_TIMEOUT_MS,
    );
  }
  return isOneBotMediaOutboxItem(item)
    ? DEFAULT_ONEBOT_MEDIA_CHAT_OUTBOX_SEND_TIMEOUT_MS
    : DEFAULT_CHAT_OUTBOX_SEND_TIMEOUT_MS;
}

function retryLeaseMs(options: ChatOutboxDrainOptions = {}) {
  return normalizePositiveMilliseconds(
    options.retryLeaseMs ?? process.env.RIN_CHAT_OUTBOX_RETRY_LEASE_MS,
    DEFAULT_CHAT_OUTBOX_RETRY_LEASE_MS,
  );
}

function chatOutboxMaxAgeMs(options: ChatOutboxDrainOptions = {}) {
  return normalizePositiveMilliseconds(
    options.maxAgeMs ?? process.env.RIN_CHAT_OUTBOX_MAX_AGE_MS,
    DEFAULT_CHAT_OUTBOX_MAX_AGE_MS,
  );
}

function isOutboxItemExpired(
  item: ChatOutboxItem,
  options: ChatOutboxDrainOptions = {},
  nowMs = Date.now(),
) {
  const createdAtMs = Date.parse(safeString(item.createdAt).trim());
  if (!Number.isFinite(createdAtMs)) return false;
  return nowMs - createdAtMs > chatOutboxMaxAgeMs(options);
}

function isOutboxItemDrainable(
  item: ChatOutboxItem,
  nowMs = Date.now(),
  options: ChatOutboxDrainOptions = {},
) {
  if (item.status === "delivered" || item.status === "failed") return false;
  if (isOutboxItemExpired(item, options, nowMs)) return true;
  if (item.status === "sending" && !isRetryDue(item, nowMs)) return false;
  return isRetryDue(item, nowMs);
}

function readCurrentOutboxItem(agentDir: string, itemId: string) {
  return readChatOutboxItem(agentDir, chatOutboxItemPath(agentDir, itemId));
}

function isSameSendingAttempt(
  current: ChatOutboxItem | null,
  sending: ChatOutboxItem,
) {
  return (
    current?.id === sending.id &&
    current.status === "sending" &&
    current.attempts === sending.attempts
  );
}

function createChatOutboxTimeoutError(timeoutMs: number) {
  return new Error(`chat_outbox_delivery_timeout:${timeoutMs}`);
}

function isChatOutboxTimeoutError(error: unknown) {
  return /^chat_outbox_delivery_timeout:/.test(chatOutboxErrorMessage(error));
}

function isAmbiguousDeliveryTimeout(error: unknown) {
  return /(?:^chat_outbox_delivery_timeout:|\b(?:onebot_action_timeout|timeout|timed out)\b)/i.test(
    chatOutboxErrorMessage(error),
  );
}

async function withChatOutboxSendTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
) {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(createChatOutboxTimeoutError(timeoutMs)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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

function warnChatOutboxDeliveryUnconfirmed(
  logger: any,
  item: ChatOutboxItem,
  error: unknown,
) {
  logger.warn(
    `chat outbox delivered_unconfirmed id=${item.id} chatKey=${safeString(item.payload?.chatKey)} attempts=${item.attempts} err=${chatOutboxErrorMessage(error)}`,
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

function deliveredChatOutboxItem(
  item: ChatOutboxItem,
  deliveryResult: string[],
): ChatOutboxItem {
  return {
    ...item,
    status: "delivered",
    updatedAt: new Date().toISOString(),
    deliveredAt: new Date().toISOString(),
    deliveryResult,
    deliveryUnconfirmed: undefined,
    lastError: undefined,
    nextAttemptAt: undefined,
    failureKind: undefined,
  };
}

function deliveredUnconfirmedChatOutboxItem(
  item: ChatOutboxItem,
  error: unknown,
): ChatOutboxItem {
  return {
    ...item,
    status: "delivered",
    updatedAt: new Date().toISOString(),
    deliveredAt: new Date().toISOString(),
    deliveryResult: item.deliveryResult || [],
    deliveryUnconfirmed: true,
    lastError: chatOutboxErrorMessage(error),
    nextAttemptAt: undefined,
    failureKind: undefined,
  };
}

function failedChatOutboxItem(
  sending: ChatOutboxItem,
  error: unknown,
): ChatOutboxItem | null {
  const message = chatOutboxErrorMessage(error);
  const partialDelivered = partialDeliveryMessageIds(error);
  const permanent = isPermanentChatOutboxError(error);
  const exhausted = sending.attempts >= CHAT_OUTBOX_MAX_ATTEMPTS;
  if (!permanent && !exhausted) return null;
  return {
    ...sending,
    status: "failed",
    updatedAt: new Date().toISOString(),
    failedAt: new Date().toISOString(),
    lastError: message,
    nextAttemptAt: undefined,
    failureKind: permanent ? "permanent" : "attempts_exhausted",
    deliveryResult: partialDelivered.length
      ? partialDelivered
      : sending.deliveryResult,
  };
}

function expiredChatOutboxItem(item: ChatOutboxItem): ChatOutboxItem {
  return {
    ...item,
    status: "failed",
    updatedAt: new Date().toISOString(),
    failedAt: new Date().toISOString(),
    lastError: "chat_outbox_expired",
    nextAttemptAt: undefined,
    failureKind: "expired",
  };
}

function queuedChatOutboxItem(
  sending: ChatOutboxItem,
  error: unknown,
  options: { keepSending?: boolean; retryAfterMs?: number } = {},
): ChatOutboxItem {
  const nextAttemptAt = Number.isFinite(options.retryAfterMs)
    ? new Date(
        Date.now() + Math.max(1, Number(options.retryAfterMs)),
      ).toISOString()
    : nextRetryAt(sending.attempts);
  return {
    ...sending,
    status: options.keepSending ? "sending" : "queued",
    updatedAt: new Date().toISOString(),
    lastError: chatOutboxErrorMessage(error),
    nextAttemptAt,
    failureKind: "retryable",
  };
}

function settleChatOutboxFailure(
  agentDir: string,
  logger: any,
  sending: ChatOutboxItem,
  error: unknown,
) {
  const failed = failedChatOutboxItem(sending, error);
  if (failed) {
    writeChatOutboxItem(agentDir, failed);
    warnChatOutboxFailure(logger, failed, error, "failed");
    return {
      status: "failed" as const,
      error: chatOutboxErrorMessage(error),
    };
  }
  const queued = queuedChatOutboxItem(sending, error);
  writeChatOutboxItem(agentDir, queued);
  warnChatOutboxFailure(logger, queued, error, "queued");
  return {
    status: "queued" as const,
    error: chatOutboxErrorMessage(error),
  };
}

function settleLateChatOutboxSuccess(
  agentDir: string,
  sending: ChatOutboxItem,
  deliveryResult: string[],
) {
  const current = readCurrentOutboxItem(agentDir, sending.id);
  if (!isSameSendingAttempt(current, sending)) return;
  const delivered = deliveredChatOutboxItem(current, deliveryResult);
  writeChatOutboxItem(agentDir, delivered);
  applyPostDelivery(agentDir, delivered);
}

function settleLateChatOutboxFailure(
  agentDir: string,
  logger: any,
  sending: ChatOutboxItem,
  error: unknown,
) {
  const current = readCurrentOutboxItem(agentDir, sending.id);
  if (!isSameSendingAttempt(current, sending)) return;
  const failed = failedChatOutboxItem(current, error);
  if (failed) {
    writeChatOutboxItem(agentDir, failed);
    warnChatOutboxFailure(logger, failed, error, "failed");
    return;
  }
  if (isAmbiguousDeliveryTimeout(error)) {
    const delivered = deliveredUnconfirmedChatOutboxItem(current, error);
    writeChatOutboxItem(agentDir, delivered);
    warnChatOutboxDeliveryUnconfirmed(logger, delivered, error);
    return;
  }
  const queued = queuedChatOutboxItem(current, error);
  writeChatOutboxItem(agentDir, queued);
  warnChatOutboxFailure(logger, queued, error, "queued");
}

async function drainChatOutboxItem(
  app: any,
  agentDir: string,
  h: any,
  logger: any,
  item: ChatOutboxItem,
  options: ChatOutboxDrainOptions = {},
) {
  if (item.status === "delivered" || item.status === "failed") {
    return { status: item.status };
  }
  if (!isOutboxItemDrainable(item, Date.now(), options)) {
    return null;
  }
  if (isOutboxItemExpired(item, options)) {
    const failed = expiredChatOutboxItem(item);
    writeChatOutboxItem(agentDir, failed);
    warnChatOutboxFailure(
      logger,
      failed,
      new Error("chat_outbox_expired"),
      "failed",
    );
    return {
      status: "failed" as const,
      error: "chat_outbox_expired",
    };
  }
  const timeoutMs = getChatOutboxSendTimeoutMs(item, options);
  const sending: ChatOutboxItem = {
    ...item,
    status: "sending",
    attempts: item.attempts + 1,
    updatedAt: new Date().toISOString(),
    nextAttemptAt: new Date(
      Date.now() + timeoutMs + retryLeaseMs(options),
    ).toISOString(),
  };
  writeChatOutboxItem(agentDir, sending);
  let deliveryTask: ReturnType<typeof sendOutboxPayload>;
  try {
    deliveryTask = sendOutboxPayload(
      app,
      agentDir,
      sending.payload,
      h,
      sending.id,
    );
  } catch (error: any) {
    return settleChatOutboxFailure(agentDir, logger, sending, error);
  }
  const dispatched = getChatOutboxDispatchPromise(
    sending.payload,
    deliveryTask,
  );
  if (dispatched) {
    try {
      await withChatOutboxSendTimeout(
        dispatched,
        DEFAULT_CHAT_OUTBOX_DISPATCH_TIMEOUT_MS,
      );
      const queued = queuedChatOutboxItem(
        sending,
        new Error("chat_outbox_delivery_pending"),
        {
          keepSending: true,
          retryAfterMs: timeoutMs + retryLeaseMs(options),
        },
      );
      writeChatOutboxItem(agentDir, queued);
      void deliveryTask.then(
        (deliveryResult) =>
          settleLateChatOutboxSuccess(agentDir, sending, deliveryResult),
        (lateError) =>
          settleLateChatOutboxFailure(agentDir, logger, sending, lateError),
      );
      return {
        status: "dispatched" as const,
      };
    } catch (error: any) {
      void deliveryTask.catch(() => {});
      return settleChatOutboxFailure(agentDir, logger, sending, error);
    }
  }
  try {
    const deliveryResult = await withChatOutboxSendTimeout(
      deliveryTask,
      timeoutMs,
    );
    const delivered = deliveredChatOutboxItem(sending, deliveryResult);
    writeChatOutboxItem(agentDir, delivered);
    applyPostDelivery(agentDir, delivered);
    return {
      status: "delivered" as const,
      deliveryResult,
    };
  } catch (error: any) {
    if (isChatOutboxTimeoutError(error)) {
      const queued = queuedChatOutboxItem(sending, error, {
        keepSending: true,
        retryAfterMs: retryLeaseMs(options),
      });
      writeChatOutboxItem(agentDir, queued);
      warnChatOutboxFailure(logger, queued, error, "queued");
      void deliveryTask.then(
        (deliveryResult) =>
          settleLateChatOutboxSuccess(agentDir, sending, deliveryResult),
        (lateError) =>
          settleLateChatOutboxFailure(agentDir, logger, sending, lateError),
      );
      return {
        status: "queued" as const,
        error: chatOutboxErrorMessage(error),
      };
    }
    return settleChatOutboxFailure(agentDir, logger, sending, error);
  }
}

function filterDrainableChatOutboxItems(
  agentDir: string,
  options: ChatOutboxDrainOptions = {},
) {
  const chatKey = safeString(options.chatKey).trim();
  const itemId = safeString(options.itemId).trim();
  return listChatOutboxItems(agentDir)
    .map(({ item }) => item)
    .filter(
      (item) =>
        (!chatKey || item.payload.chatKey === chatKey) &&
        (!itemId || item.id === itemId || !chatKey),
    )
    .filter((item) => isOutboxItemDrainable(item, Date.now(), options));
}

async function drainChatOutboxNowForChat(
  app: any,
  agentDir: string,
  h: any,
  logger: any,
  chatKey: string,
  options: ChatOutboxDrainOptions = {},
) {
  const results: Array<{ id: string; status?: string }> = [];
  for (const item of filterDrainableChatOutboxItems(agentDir, {
    ...options,
    chatKey,
  })) {
    const result = await drainChatOutboxItem(
      app,
      agentDir,
      h,
      logger,
      item,
      options,
    );
    if (result) results.push({ id: item.id, ...(result || {}) });
  }
  return results;
}

async function runWithChatOutboxDrainQueue<T>(
  chatKey: string,
  run: () => Promise<T>,
) {
  const key = safeString(chatKey).trim() || "unknown";
  const previous = chatOutboxDrainQueues.get(key) || Promise.resolve();
  let release!: () => void;
  const slot = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.then(
    () => slot,
    () => slot,
  );
  chatOutboxDrainQueues.set(key, current);
  await previous.catch(() => {});
  try {
    return await run();
  } finally {
    release();
    if (chatOutboxDrainQueues.get(key) === current) {
      chatOutboxDrainQueues.delete(key);
    }
  }
}

export async function drainChatOutbox(
  app: any,
  agentDir: string,
  h: any,
  logger: any,
  options: ChatOutboxDrainOptions = {},
) {
  const targetChatKey = safeString(options.chatKey).trim();
  if (targetChatKey) {
    return await runWithChatOutboxDrainQueue(targetChatKey, () =>
      drainChatOutboxNowForChat(
        app,
        agentDir,
        h,
        logger,
        targetChatKey,
        options,
      ),
    );
  }
  const chatKeys = Array.from(
    new Set(
      filterDrainableChatOutboxItems(agentDir).map(
        (item) => item.payload.chatKey,
      ),
    ),
  );
  const grouped = await Promise.all(
    chatKeys.map((chatKey) =>
      runWithChatOutboxDrainQueue(chatKey, () =>
        drainChatOutboxNowForChat(app, agentDir, h, logger, chatKey, options),
      ),
    ),
  );
  return grouped.flat();
}
