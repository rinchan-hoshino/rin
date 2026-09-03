import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  createEventBus,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";

import {
  applyRuntimeProfileEnvironment,
  resolveRuntimeProfile,
} from "../rin-lib/profile.js";
import {
  getRinNonInteractiveCommandInteractionPolicy,
  type RinFrontendTurnClient,
} from "../rin-frontend-sdk/index.js";
import {
  createRinHttpTransport,
  type RinHttpTransport,
} from "../http/transport.js";
import { nowIso } from "../time-utils.js";
import {
  executeChatBridgeCode,
  renderChatBridgeResult,
} from "../chat-bridge/eval.js";
import {
  appendChatBridgeAudit,
  createChatBridgeRuntime,
} from "../chat-bridge/runtime.js";
import {
  chatStateDir,
  listChatStateFiles,
  listDetachedControllerStateFiles,
} from "./support.js";
import {
  drainChatOutbox,
  isChatCommandConcurrent,
  loadChatCommandRows,
  reconcileCommittedChatOutboxProcessing,
  refreshChatCommandRows,
  syncDiscordCommands,
  syncTelegramCommands,
  type ChatCommandRow,
} from "./boot.js";
import {
  elementsToText,
  ensureDir,
  ensureSessionElements,
  extractInboundAttachments,
  buildInboundAttachmentNotice,
  getChatId,
  getChatType,
  enrichInboundMessageMetadata,
  pickChatName,
  pickMessageId,
  pickSenderNickname,
  pickUserId,
  renderInboundMessageText,
  renderPromptTextWithSavedAttachments,
  safeString,
  hasInboundChatMessageReplyBoundary,
  isInboundChatMessageProcessed,
  markProcessedChatMessage,
} from "./chat-helpers.js";
import {
  formatChatErrorDelivery,
  formatChatErrorParts,
} from "./error-presentation.js";
import { buildInboundChatLogInput } from "./inbound-normalization.js";
import { withoutChatQuoteNodes } from "./rich-text.js";
import { buildChatMessageRecordKey } from "./message-store.js";
import { ChatController, loadChatSettings } from "./controller.js";
import { queryChatSessionStatus, renderChatSessionStatus } from "./status.js";
import {
  resolveChatModelOptions,
  resolveChatTurnPolicyMode,
} from "./settings.js";
import { appendChatLog } from "./chat-log.js";
import {
  type ChatInboxAdmission,
  type DurableChatAdmissionCommit,
  type FrozenChatTurnSubmission,
  resolveDurableChatAdmission,
} from "./durable-admission.js";
import {
  type ChatInboxItem,
  abortEarlierChatInboxItems,
  commitClaimedChatInboxAdmission,
  enqueueChatInboxItem,
  getChatInboxItem,
  getChatInboxItemByMessageId,
  restoreChatInboxElements,
  restoreChatInboxSession,
  listRunningChatInboxItems,
  reclaimRunningChatInboxItem,
  touchClaimedChatInboxItem,
} from "./inbox.js";
import {
  type ClaimedChatInboxJob,
  type ChatInboxJobResult,
  createChatInboxDrain,
  finalizeClaimedChatInboxJob,
} from "./inbox-drain.js";
import {
  type PreparedChatKeyWorkerJob,
  createChatKeyWorkerPool,
  createStartupRecoveryAdmission,
  estimateStartupRecoveryMemoryBytes,
  readSystemAvailableMemoryBytes,
  runStartupRecoveryWithAdmission,
} from "./chat-key-worker.js";
import {
  isEffectivePrivateChatSession,
  resolveChatInputAccess,
  shouldProcessText,
} from "./decision.js";
import {
  addBuiltInPlatforms,
  createChat,
  createChatNodes,
  type Chat,
} from "./chat.js";
import {
  listBuiltInChatPlatformEntries,
  listChatPlatformEntries,
} from "./runtime-config.js";
import {
  composeChatKey,
  composeChatKeyForBot,
  loadIdentity,
  parseChatKey,
  trustOf,
} from "./support.js";
import { recoverInboundHeads } from "./inbound-recovery.js";
import { migrateChatDatabase } from "./database-migration.js";
import { openChatDatabase } from "./database.js";
import {
  RIN_CHAT_PLATFORM_EVENT,
  type RinChatPlatform,
  type RinChatPlatformBot,
  type RinChatPlatformContribution,
} from "../rin-extension-api.js";
import { RinDaemonFrontendClient } from "../rin-frontend-sdk/daemon-client.js";
import type { PromptContextMeta } from "../rin-lib/prompt-context.js";
import {
  normalizeFrontendIdentity,
  type RinFrontendIdentity,
} from "../rin-lib/frontend-identity.js";
import type { RinToolStartupOptions } from "../rin-lib/tool-options.js";
import type { RinPiPassthroughOptions } from "../rin-lib/pi-passthrough.js";
import { createChatTerminalReconciliationLoop } from "./terminal-reconciler.js";
import type {
  ChatOutboxPayloadInput,
  ChatOutboxTurnFence,
  EnqueueChatOutboxOptions,
} from "../rin-lib/chat-outbox-contract.js";
import {
  cleanupChatOutboxHistory,
  enqueueChatOutboxPayload,
  hasCommittedTerminalChatOutbox,
  runWithChatOutboxTurnFence,
  waitForChatOutboxDelivery,
} from "./outbox.js";
import { withChatQuotePart } from "./delivery-presentation.js";
import {
  sendReaction,
  sendTyping,
  validateChatOutboxPayloadForDispatch,
} from "./transport.js";
import {
  normalizeSessionRef,
  resolveStoredSessionFile,
} from "../session/ref.js";

function createLogger(name: string) {
  const prefix = `[${name}]`;
  return {
    debug: (...args: any[]) => console.debug(prefix, ...args),
    info: (...args: any[]) => console.info(prefix, ...args),
    warn: (...args: any[]) => console.warn(prefix, ...args),
    error: (...args: any[]) => console.error(prefix, ...args),
  };
}

const logger = createLogger("rin-chat");
const TYPING_POLL_INTERVAL_MS = 1000;
const CHAT_INBOX_POLL_INTERVAL_MS = 3000;
const CHAT_OUTBOX_POLL_INTERVAL_MS = 5000;
const CHAT_OUTBOX_HISTORY_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHAT_INBOX_PROCESSING_HEARTBEAT_MS = 30 * 1000;
const DETACHED_CONTROLLER_SLEEP_IDLE_MS = 60_000;
const TELEGRAM_CHAT_THREAD_MARKER = "?thread=";

export function buildChatMessagePromptMeta(input: {
  session: any;
  identity: ReturnType<typeof loadIdentity>;
  chatKey: string;
  chatType: string;
  requiresMentionToStartTurn?: boolean;
  attachments: any[];
  task?: { id: string; name?: string };
}): PromptContextMeta {
  const taskId = safeString(input.task?.id).trim();
  const taskName = safeString(input.task?.name).trim();
  return {
    source: "chat-bridge",
    sentAt: Number.isFinite(Number(input.session?.timestamp))
      ? Number(input.session.timestamp)
      : Date.now(),
    chatKey: input.chatKey,
    chatName:
      pickChatName(input.session) ||
      (input.chatType === "private" ? pickSenderNickname(input.session) : ""),
    chatType: input.chatType,
    userId: pickUserId(input.session),
    nickname: pickSenderNickname(input.session),
    identity: trustOf(
      input.identity,
      safeString(input.session?.platform).trim(),
      pickUserId(input.session),
    ),
    runtimeMetadata:
      input.session?.runtimeMetadata &&
      typeof input.session.runtimeMetadata === "object"
        ? input.session.runtimeMetadata
        : undefined,
    requiresMentionToStartTurn: input.requiresMentionToStartTurn || undefined,
    attachedFiles: input.attachments
      .filter((item) => item?.kind === "file")
      .map((item) => ({ name: item.name, path: item.path })),
    ...(taskId ? { taskId } : {}),
    ...(taskName ? { taskName } : {}),
  };
}

function isChatPlatformContribution(
  value: unknown,
): value is RinChatPlatformContribution {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RinChatPlatformContribution>;
  return (
    candidate.apiVersion === 1 &&
    /^[a-z][a-z0-9_-]*$/.test(safeString(candidate.platform).trim()) &&
    typeof candidate.create === "function"
  );
}

async function loadExternalChatPlatformContributions(input: {
  cwd: string;
  agentDir: string;
  additionalExtensionPaths?: string[];
}) {
  const eventBus = createEventBus();
  const contributions: RinChatPlatformContribution[] = [];
  const unsubscribe = eventBus.on(RIN_CHAT_PLATFORM_EVENT, (value) => {
    if (isChatPlatformContribution(value)) {
      contributions.push(value);
    } else {
      logger.warn("ignored invalid rin.chat.platform.v1 contribution");
    }
  });
  try {
    const resourceLoader = new DefaultResourceLoader({
      cwd: input.cwd,
      agentDir: input.agentDir,
      eventBus,
      additionalExtensionPaths: input.additionalExtensionPaths || [],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    const loaded = resourceLoader.getExtensions();
    for (const failure of loaded.errors) {
      logger.warn(
        `Pi extension load failed path=${failure.path} err=${failure.error}`,
      );
    }
  } finally {
    unsubscribe();
    eventBus.clear();
  }

  const unique = new Map<string, RinChatPlatformContribution>();
  for (const contribution of contributions) {
    const key = safeString(contribution.platform).trim();
    if (unique.has(key)) {
      logger.warn(`ignored duplicate Chat platform contribution=${key}`);
      continue;
    }
    unique.set(key, contribution);
  }
  return [...unique.values()];
}

function isChatPlatform(value: unknown): value is RinChatPlatform {
  if (!value || typeof value !== "object") return false;
  const platform = value as Partial<RinChatPlatform>;
  const bot = platform.bot as Partial<RinChatPlatformBot> | undefined;
  return (
    Boolean(bot) &&
    typeof bot?.platform === "string" &&
    typeof bot?.selfId === "string" &&
    typeof bot?.sendMessage === "function" &&
    typeof platform.start === "function" &&
    typeof platform.stop === "function"
  );
}

async function addExternalChatPlatforms(
  chat: Chat,
  input: {
    cwd: string;
    agentDir: string;
    dataDir: string;
    settings: unknown;
    additionalExtensionPaths?: string[];
  },
) {
  const contributions = await loadExternalChatPlatformContributions(input);
  for (const contribution of contributions) {
    const platformName = safeString(contribution.platform).trim();
    const entries = listChatPlatformEntries(
      input.settings,
      platformName,
      contribution.defaults,
    );
    for (const entry of entries) {
      try {
        const platform = await contribution.create({
          agentDir: input.agentDir,
          dataDir: input.dataDir,
          config: entry.config,
          logger,
          receive: (session) => chat.emit("message", session),
          updateStatus: (bot, status) => chat.updateStatus(bot, status),
          composeKey: (chatId, botId) =>
            composeChatKey(platformName, chatId, botId),
          beginRecovery: (chatKey) => chat.beginInboundRecoveryChat(chatKey),
          completeRecovery: (chatKey) =>
            chat.completeInboundRecoveryChat(chatKey),
          recoverInbound: async (botId, recover, options) =>
            await recoverInboundHeads(
              input.agentDir,
              platformName,
              botId,
              recover,
              options,
            ),
        });
        if (!isChatPlatform(platform)) {
          throw new Error(
            "Chat platform did not return a usable implementation",
          );
        }
        if (safeString(platform.bot.platform).trim() !== platformName) {
          throw new Error(
            "Chat platform identity does not match its registration",
          );
        }
        chat.addPlatform(platform);
      } catch (error) {
        chat.registerPlatformFailure(
          { platform: platformName, selfId: entry.name },
          error,
        );
        logger.warn(
          `external Chat platform init failed platform=${platformName} name=${entry.name} err=${safeString((error as any)?.message || error)}`,
        );
      }
    }
  }
}

function appendTelegramThreadToChatKey(chatKey: string, session: any) {
  const nextChatKey = safeString(chatKey).trim();
  if (!nextChatKey) return "";
  const platform = safeString(session?.platform || "").trim();
  if (platform !== "telegram") return nextChatKey;
  const messageThreadId = safeString(
    session?.messageThreadId || session?.chatThreadId || "",
  ).trim();
  if (!messageThreadId || nextChatKey.includes(TELEGRAM_CHAT_THREAD_MARKER)) {
    return nextChatKey;
  }
  return `${nextChatKey}${TELEGRAM_CHAT_THREAD_MARKER}${encodeURIComponent(messageThreadId)}`;
}

async function buildTelegramInboundMediaDebug(session: any) {
  const update = session?.telegram;
  if (!update || typeof update !== "object") return undefined;
  const message =
    update?.message ||
    update?.edited_message ||
    update?.channel_post ||
    update?.edited_channel_post;
  if (!message || typeof message !== "object") return undefined;
  const photo = Array.isArray(message?.photo) ? message.photo : [];
  const candidates = [
    ...photo.map((item: any) => ({
      kind: "photo",
      fileId: safeString(item?.file_id || "").trim(),
      fileUniqueId: safeString(item?.file_unique_id || "").trim() || undefined,
      fileSize: Number.isFinite(Number(item?.file_size))
        ? Number(item.file_size)
        : undefined,
      width: Number.isFinite(Number(item?.width))
        ? Number(item.width)
        : undefined,
      height: Number.isFinite(Number(item?.height))
        ? Number(item.height)
        : undefined,
    })),
    message?.document
      ? {
          kind: "document",
          fileId: safeString(message.document?.file_id || "").trim(),
          fileUniqueId:
            safeString(message.document?.file_unique_id || "").trim() ||
            undefined,
          fileSize: Number.isFinite(Number(message.document?.file_size))
            ? Number(message.document.file_size)
            : undefined,
          mimeType:
            safeString(message.document?.mime_type || "").trim() || undefined,
          fileName:
            safeString(message.document?.file_name || "").trim() || undefined,
        }
      : null,
  ]
    .filter(Boolean)
    .filter((item: any) => item.fileId);
  if (!candidates.length) return undefined;
  const lookups: any[] = [];
  const getFile = session?.bot?.internal?.getFile;
  if (typeof getFile === "function") {
    for (const item of candidates.slice(0, 4)) {
      try {
        const file = await getFile.call(session.bot.internal, {
          file_id: item.fileId,
        });
        lookups.push({
          fileId: item.fileId,
          ok: true,
          filePath: safeString(file?.file_path || "").trim() || undefined,
          fileSize: Number.isFinite(Number(file?.file_size))
            ? Number(file.file_size)
            : undefined,
        });
      } catch (error: any) {
        lookups.push({
          fileId: item.fileId,
          ok: false,
          error: safeString(
            error?.description || error?.message || error,
          ).trim(),
        });
      }
    }
  }
  return {
    messageId: safeString(message?.message_id || "").trim() || undefined,
    photoCount: photo.length || undefined,
    media: candidates,
    lookups: lookups.length ? lookups : undefined,
  };
}

function getCommandTargets(session: any) {
  return new Set(
    [
      session?.bot?.user?.name,
      session?.bot?.user?.username,
      session?.bot?.username,
      session?.bot?.name,
      session?.username,
      session?.selfId,
    ]
      .map((value) => safeString(value).trim().replace(/^@+/, "").toLowerCase())
      .filter(Boolean),
  );
}

type ParsedInboundCommand = { name: string; argsText: string };

const REMOVED_CHAT_COMMAND_NAMES = new Set(["session"]);
const BUILTIN_ACTIVE_CHAT_KEY_PRIORITY_COMMAND_NAMES = new Set([
  "abort",
  "new",
  "status",
]);

type InboundCommandRequest = {
  commandLike: boolean;
  name: string;
  argsText: string;
  command: ParsedInboundCommand | null;
};

function parseInboundCommandRequest(
  session: any,
  text: string,
  commandRows: Array<{ name: string }>,
): InboundCommandRequest {
  const empty = {
    commandLike: false,
    name: "",
    argsText: "",
    command: null,
  };
  const input = safeString(text).trim();
  if (!input.startsWith("/")) return empty;
  const spaceIndex = input.indexOf(" ");
  const head = (spaceIndex >= 0 ? input.slice(0, spaceIndex) : input)
    .slice(1)
    .trim();
  if (!head) return empty;
  const argsText = spaceIndex >= 0 ? input.slice(spaceIndex + 1).trim() : "";
  const [rawName, rawTarget = ""] = head.split("@", 2);
  const name = safeString(rawName).trim().toLowerCase();
  if (!name) return empty;
  const commandLike = true;
  const target = safeString(rawTarget).trim().replace(/^@+/, "").toLowerCase();
  if (target) {
    const targets = getCommandTargets(session);
    if (targets.size && !targets.has(target)) {
      return { commandLike, name, argsText, command: null };
    }
  }
  const active = commandRows.some(
    (item) => safeString(item?.name).trim() === name,
  );
  return {
    commandLike,
    name,
    argsText,
    command: active ? { name, argsText } : null,
  };
}

function parseInboundCommand(
  session: any,
  text: string,
  commandRows: Array<{ name: string }>,
) {
  return parseInboundCommandRequest(session, text, commandRows).command;
}

function elementsToCommandText(elements: any[]) {
  return elementsToText(withoutChatQuoteNodes(elements));
}

export type ChatBridgeTurnPayload = RinToolStartupOptions &
  Pick<RinPiPassthroughOptions, "piStartupOptions"> & {
    chatKey?: string;
    controllerKey?: string;
    affectChatBinding?: boolean;
    linkDeliveriesToSession?: boolean;
    disposeAfterTurn?: boolean;
    shutdownAfterTurn?: boolean;
    deliverFinal?: boolean;
    quietMode?: boolean;
    text: string;
    replyToMessageId?: string;
    sessionFile?: string;
    sessionName?: string;
    managedSessionLeaf?: string;
    createSessionFileIfMissing?: boolean;
    model?: string;
    thinkingLevel?: string;
    promptMeta?: PromptContextMeta;
    requestTag?: string;
    deliveryIdempotencyKey?: string;
    frontend?: RinFrontendIdentity;
    disabledRinCapabilities?: string[];
  };

export type ChatBridgeEvalPayload = {
  createdAt: string;
  requestId?: string;
  currentChatKey?: string;
  code: string;
  timeoutMs?: number;
  sessionId?: string;
  sessionFile?: string;
};

export type ChatBridgeStatus = {
  ready: boolean;
  status: "ready" | "degraded";
  startedAt: string;
  settingsPath: string;
  adapterCount: number;
  botCount: number;
  controllerCount: number;
  detachedControllerCount: number;
  adapters: Array<{
    platform: string;
    selfId: string;
    status: "registered" | "starting" | "ready" | "degraded" | "stopped";
    error?: string;
  }>;
  stopping?: boolean;
};

export type ChatBridgeHandle = {
  app: Chat;
  options: {
    additionalExtensionPaths?: string[];
    hosted?: boolean;
    frontendClientFactory?: () => RinFrontendTurnClient;
  };
  stop: () => Promise<void>;
  getStatus: () => ChatBridgeStatus;
  send: (
    payload: ChatOutboxPayloadInput,
    options?: {
      waitUntilDeliverySettled?: boolean;
      waitForDeliveryMs?: number;
      idempotencyKey?: string;
    },
  ) => Promise<
    | { delivered: true; messageIds?: string[] }
    | {
        delivered: false;
        pending: true;
        outboxId: string;
        messageIds?: string[];
      }
  >;
  typing: (payload: { chatKey?: string }) => Promise<{ sent: boolean }>;
  react: (payload: {
    chatKey?: string;
    messageId?: string;
    emoji?: string;
  }) => Promise<{ sent: boolean }>;
  runTurn: (payload: ChatBridgeTurnPayload) => Promise<any>;
  submitIncoming: (payload: {
    chatKey: string;
    text: string;
    taskId: string;
    taskName?: string;
    showInput?: boolean;
    deliverFinal?: boolean;
    quietMode?: boolean;
    deliveryIdempotencyKey?: string;
  }) => Promise<any>;
  terminateTurn: (payload: {
    controllerKey?: string;
    chatKey?: string;
  }) => Promise<any>;
  evalBridge: (payload: ChatBridgeEvalPayload) => Promise<any>;
};

export async function startChatBridge(
  options: {
    additionalExtensionPaths?: string[];
    hosted?: boolean;
    frontendClientFactory?: () => RinFrontendTurnClient;
    settingsPath?: string;
    /** Explicit catalog injection for hosted and test environments. */
    commandRows?: ChatCommandRow[];
  } = {},
): Promise<ChatBridgeHandle> {
  const runtime = resolveRuntimeProfile();
  const dataDir = path.join(runtime.agentDir, "data");
  const settingsPath =
    safeString(options.settingsPath).trim() ||
    path.join(runtime.agentDir, "settings.json");
  applyRuntimeProfileEnvironment(runtime);
  if (process.cwd() !== runtime.cwd) process.chdir(runtime.cwd);
  ensureDir(dataDir);
  try {
    openChatDatabase(runtime.agentDir);
  } catch (error: any) {
    const message = safeString(error?.message || error);
    if (
      !/^chat_database_(?:schema_upgrade_required|incomplete_schema)/.test(
        message,
      )
    ) {
      throw error;
    }
    migrateChatDatabase(runtime.agentDir, { runtimeQuiesced: true });
  }

  const settings = loadChatSettings(settingsPath);
  const startupRecoveryAdmission = createStartupRecoveryAdmission({
    availableMemoryBytes: readSystemAvailableMemoryBytes,
    logger,
  });

  const h = createChatNodes();
  const app = createChat(runtime.agentDir);
  let inboundHttpTransport: RinHttpTransport | null = null;
  const getInboundHttpTransport = () => {
    inboundHttpTransport ||= createRinHttpTransport();
    return inboundHttpTransport;
  };
  app.on("adapter-start-failed", (adapter: any) => {
    logger.warn(
      `chat adapter startup degraded platform=${safeString(adapter?.platform).trim() || "unknown"} selfId=${safeString(adapter?.selfId).trim()} err=${safeString(adapter?.error).trim() || "adapter_start_failed"}`,
    );
  });
  app.on("adapter-stop-failed", (adapter: any) => {
    logger.warn(
      `chat adapter shutdown degraded platform=${safeString(adapter?.platform).trim() || "unknown"} selfId=${safeString(adapter?.selfId).trim()} err=${safeString(adapter?.error).trim() || "adapter_stop_failed"}`,
    );
  });
  const enqueueAndDrainOutbox = async (
    payload: ChatOutboxPayloadInput,
    deliveryKind: "command_ack" | "error" | "generic" = "generic",
    options: EnqueueChatOutboxOptions & { onEnqueued?: () => void } = {},
  ) => {
    const id =
      safeString(options.id).trim() ||
      `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const deliveryPayload =
      deliveryKind === "error"
        ? {
            ...payload,
            deliveryKind,
            parts: formatChatErrorDelivery({ parts: payload.parts }).parts,
          }
        : payload;
    await validateChatOutboxPayloadForDispatch(deliveryPayload, h);
    const outboxId = enqueueChatOutboxPayload(
      runtime.agentDir,
      deliveryPayload,
      {
        id,
        idempotencyKey: options.idempotencyKey,
        deliveryKind,
        normalizeExistingErrorParts: formatChatErrorParts,
        postDelivery: options.postDelivery,
      },
    );
    options.onEnqueued?.();
    const results = await drainChatOutbox(app, runtime.agentDir, h, logger, {
      chatKey: safeString(deliveryPayload.chatKey).trim(),
      itemId: outboxId,
    });
    const own = Array.isArray(results)
      ? results.find((item: any) => item?.id === outboxId)
      : null;
    if (!own) {
      throw new Error("chat_outbox_delivery_missing");
    }
    if (
      own.status !== "delivered" &&
      own.status !== "dispatched" &&
      own.status !== "queued"
    ) {
      throw new Error(
        safeString((own as any).error).trim() || "chat_outbox_delivery_pending",
      );
    }
    return { ...own, id: outboxId };
  };
  addBuiltInPlatforms(app, {
    dataDir,
    entries: listBuiltInChatPlatformEntries(settings),
    logger,
  });
  await addExternalChatPlatforms(app, {
    cwd: runtime.cwd,
    agentDir: runtime.agentDir,
    dataDir,
    settings,
    additionalExtensionPaths: options.additionalExtensionPaths,
  });
  const controllers = new Map<string, ChatController>();
  const detachedControllers = new Map<string, ChatController>();
  const detachedControllerSignatures = new Map<string, string>();
  const retiredDetachedControllers = new Set<ChatController>();
  const detachedControllerUsers = new Map<ChatController, number>();
  const detachedControllerCleanup = new Map<
    ChatController,
    "dispose" | "shutdown"
  >();
  let inboxPollTimer: NodeJS.Timeout | null = null;
  let outboxPollTimer: NodeJS.Timeout | null = null;
  const terminalRecoveryClient = options.frontendClientFactory?.() || null;
  let chatBridgeStopping = false;
  let outboxHistoryCleanupTimer: NodeJS.Timeout | null = null;
  const runOutboxHistoryCleanup = () => {
    const result = cleanupChatOutboxHistory(runtime.agentDir);
    if (result.delivered || result.failed) {
      logger.info(
        `chat outbox history cleanup removed delivered=${result.delivered} failed=${result.failed}`,
      );
    }
  };
  const requestDrainChatOutbox = () => {
    void drainChatOutbox(app, runtime.agentDir, h, logger).catch(
      (error: any) => {
        logger.warn(
          `chat outbox drain failed err=${safeString(error?.message || error)}`,
        );
      },
    );
  };
  let typingPollTimer: NodeJS.Timeout | null = null;
  const cleanupFailedStartup = async () => {
    if (typingPollTimer) {
      clearInterval(typingPollTimer);
      typingPollTimer = null;
    }
    await terminalRecoveryClient?.disconnect().catch(() => {});
    await app.stop().catch(() => {});
    await inboundHttpTransport?.close().catch(() => {});
  };
  const onWorkingMessage = (message: string) => {
    app.setWorkingText(message);
  };
  const frontendClientFactory = options.frontendClientFactory;
  let commandRows: Awaited<ReturnType<typeof loadChatCommandRows>>;
  const isActiveChatKeyPriorityCommand = (commandName: string) =>
    BUILTIN_ACTIVE_CHAT_KEY_PRIORITY_COMMAND_NAMES.has(commandName) ||
    isChatCommandConcurrent(commandRows, commandName);
  try {
    commandRows =
      options.commandRows ??
      (await loadChatCommandRows(
        frontendClientFactory?.() ?? new RinDaemonFrontendClient(),
      ));
  } catch (error) {
    await cleanupFailedStartup();
    throw error;
  }
  const refreshChatCommands = async () => {
    if (options.commandRows) return;
    await refreshChatCommandRows(
      commandRows,
      frontendClientFactory?.() ?? new RinDaemonFrontendClient(),
    );
    await Promise.all([
      syncTelegramCommands(app, logger, commandRows),
      syncDiscordCommands(app, logger, commandRows),
    ]);
  };
  const getIdentity = () => loadIdentity(dataDir);
  const getController = (chatKey: string) => {
    let controller = controllers.get(chatKey);
    if (!controller) {
      controller = new ChatController(app, dataDir, chatKey, {
        logger,
        h,
        frontendClientFactory,
        onWorkingMessage,
      });
      controllers.set(chatKey, controller);
    }
    return controller;
  };
  const getDetachedController = (
    controllerKey: string,
    detachedOptions?: {
      chatKey?: string;
      affectChatBinding?: boolean;
      linkDeliveriesToSession?: boolean;
      frontendIdentity?: RinFrontendIdentity;
      useChatFrontendIdentity?: boolean;
    },
  ) => {
    const controllerChatKey =
      safeString(detachedOptions?.chatKey).trim() || `cron:${controllerKey}`;
    const affectChatBinding = detachedOptions?.affectChatBinding !== false;
    const linkDeliveriesToSession =
      detachedOptions?.linkDeliveriesToSession ?? affectChatBinding;
    const useChatFrontendIdentity =
      detachedOptions?.useChatFrontendIdentity ??
      Boolean(detachedOptions?.chatKey);
    const signature = JSON.stringify({
      controllerChatKey,
      affectChatBinding,
      linkDeliveriesToSession,
      frontendIdentity: detachedOptions?.frontendIdentity || null,
      useChatFrontendIdentity,
    });
    const signatureId = crypto
      .createHash("sha256")
      .update(signature)
      .digest("hex");
    const statePath = path.join(
      dataDir,
      "scheduler",
      "turns",
      safeString(controllerKey)
        .trim()
        .replace(/[^A-Za-z0-9._:-]+/g, "_"),
      signatureId,
      "state.json",
    );
    let controller = detachedControllers.get(controllerKey);
    if (
      controller &&
      detachedControllerSignatures.get(controllerKey) !== signature
    ) {
      if ((detachedControllerUsers.get(controller) || 0) > 0) {
        retiredDetachedControllers.add(controller);
      } else {
        controller.dispose();
      }
      detachedControllers.delete(controllerKey);
      detachedControllerSignatures.delete(controllerKey);
      controller = undefined;
    }
    if (!controller) {
      controller = new ChatController(app, dataDir, controllerChatKey, {
        logger,
        h,
        affectChatBinding,
        linkDeliveriesToSession,
        statePath,
        frontendClientFactory,
        sleepAfterIdleMs: DETACHED_CONTROLLER_SLEEP_IDLE_MS,
        onWorkingMessage,
        frontendIdentity: detachedOptions?.frontendIdentity,
        useChatFrontendIdentity,
      });
      detachedControllers.set(controllerKey, controller);
      detachedControllerSignatures.set(controllerKey, signature);
    }
    return controller;
  };
  const terminalReconciliation = createChatTerminalReconciliationLoop({
    client: terminalRecoveryClient,
    isStopping: () => chatBridgeStopping,
    controllers,
    detachedControllers,
    detachedControllerSignatures,
    getDetachedController,
    logger,
  });
  const requestReconcileChatTerminals = terminalReconciliation.request;
  const findRuntimeBot = (platform: string, selfId: string) =>
    (Array.isArray(app.bots) ? app.bots : []).find(
      (bot: any) =>
        safeString(bot?.platform).trim() === safeString(platform).trim() &&
        safeString(bot?.selfId).trim() === safeString(selfId).trim(),
    );
  const sessionChatKey = (session: any) =>
    appendTelegramThreadToChatKey(
      composeChatKeyForBot(
        app,
        safeString(session?.platform || "").trim(),
        getChatId(session),
        safeString(session?.selfId || session?.bot?.selfId || "").trim(),
      ),
      session,
    );
  const isRecordOnlyChatKey = (chatKey: string) =>
    resolveChatTurnPolicyMode(settings, chatKey) === "record_only";
  const isInboundMessageProcessed = (chatKey: string, messageId: string) =>
    hasInboundChatMessageReplyBoundary(runtime.agentDir, chatKey, messageId);
  const handleUnmatchedCommandSession = async (
    commandName: string,
    chatKey: string,
    messageId: string,
    respond: boolean,
  ) => {
    if (!respond) return {};
    await enqueueAndDrainOutbox(
      {
        createdAt: nowIso(),
        chatKey,
        parts: withChatQuotePart(
          [
            {
              type: "text",
              text: "Unknown command. Send /help to see available commands.",
            },
          ],
          messageId,
        ),
      },
      "error",
      {
        idempotencyKey: messageId
          ? JSON.stringify(["unknown_command", chatKey, messageId])
          : undefined,
        postDelivery: messageId
          ? {
              markProcessed: {
                chatKey,
                messageId,
                bindSession: false,
              },
            }
          : undefined,
      },
    );
    return {};
  };

  const sendLocalCommandReply = async (
    commandName: string,
    text: string,
    chatKey: string,
    messageId: string,
  ) => {
    await enqueueAndDrainOutbox(
      {
        createdAt: nowIso(),
        chatKey,
        parts: withChatQuotePart([{ type: "text", text }], messageId),
      },
      "command_ack",
      {
        idempotencyKey: messageId
          ? JSON.stringify([`${commandName}_command`, chatKey, messageId])
          : undefined,
        postDelivery: messageId
          ? {
              markProcessed: {
                chatKey,
                messageId,
                bindSession: false,
              },
            }
          : undefined,
      },
    );
  };

  const buildCommandPromptMeta = (
    session: any,
    trust: string,
  ): PromptContextMeta => ({
    source: "chat-bridge",
    sentAt: Number.isFinite(Number(session?.timestamp))
      ? Number(session.timestamp)
      : Date.now(),
    chatKey: sessionChatKey(session),
    chatName:
      pickChatName(session) ||
      (getChatType(session) === "private" ? pickSenderNickname(session) : ""),
    chatType: getChatType(session),
    userId: pickUserId(session),
    nickname: pickSenderNickname(session),
    identity: trust,
    runtimeMetadata:
      session?.runtimeMetadata && typeof session.runtimeMetadata === "object"
        ? session.runtimeMetadata
        : undefined,
  });

  const handleCommandSession = async (
    command: { name: string; argsText: string },
    promptMeta: PromptContextMeta,
    chatKey: string,
    messageId: string,
    outboxTurnFence: ChatOutboxTurnFence,
    createdAt: string,
  ) => {
    if (command.name === "help") {
      const lines = commandRows.map(
        (entry) =>
          `/${entry.name}${entry.description ? ` — ${entry.description}` : ""}`,
      );
      await sendLocalCommandReply("help", lines.join("\n"), chatKey, messageId);
      return {};
    }

    const controller = getController(chatKey);
    if (command.name === "status") {
      const snapshot = controller.getChatSessionStatusSnapshot();
      const status = await queryChatSessionStatus({
        agentDir: runtime.agentDir,
        sessionFile: snapshot.sessionFile,
        localTurnActive: snapshot.localTurnActive,
      });
      await sendLocalCommandReply(
        "status",
        renderChatSessionStatus(status),
        chatKey,
        messageId,
      );
      return {};
    }

    const text = `/${command.name}${command.argsText ? ` ${command.argsText}` : ""}`;
    if (command.name === "abort") {
      abortEarlierChatInboxItems(runtime.agentDir, {
        chatKey,
        beforeCreatedAt: createdAt,
      });
      for (const claimed of claimedInboxJobs.values()) {
        if (
          claimed.envelope.chatKey === chatKey &&
          claimed.envelope.createdAt < createdAt
        ) {
          claimedInboxClaimLost.get(claimed.envelope.itemId)?.();
        }
      }
    }
    try {
      await controller.runCommand(
        text,
        messageId,
        messageId,
        "",
        promptMeta,
        outboxTurnFence,
      );
      if (command.name === "reload") {
        await refreshChatCommands().catch((error: any) => {
          logger.warn(
            `chat command catalog refresh failed err=${safeString(error?.message || error)}`,
          );
        });
      }
      return { disposition: "actionable" as const };
    } catch (error) {
      logger.warn(
        `chat command failed chatKey=${chatKey} command=${command.name} err=${safeString((error as any)?.message || error)}`,
      );
      return {
        errorMessage: safeString((error as any)?.message || error),
      };
    }
  };

  const prepareAllowedChatTurnSubmission = async (
    session: any,
    elements: any[],
    identity: any,
    decision: Awaited<ReturnType<typeof shouldProcessText>>,
    receivedAt?: string,
  ): Promise<FrozenChatTurnSubmission> => {
    const messageId = pickMessageId(session);
    const promptElements = elements;
    const { attachments, failures } = await extractInboundAttachments(
      elements,
      chatStateDir(dataDir, decision.chatKey),
      getInboundHttpTransport(),
    );
    if (failures.length) {
      let telegramDebug = "";
      if (safeString(session?.platform).trim() === "telegram") {
        try {
          const detail = await buildTelegramInboundMediaDebug(session);
          if (detail) telegramDebug = ` telegram=${JSON.stringify(detail)}`;
        } catch (error: any) {
          telegramDebug = ` telegramDebugErr=${safeString(error?.message || error)}`;
        }
      }
      logger.warn(
        `chat inbound media unresolved chatKey=${decision.chatKey} messageId=${messageId || "unknown"} failures=${JSON.stringify(failures)}${telegramDebug}`,
      );
    }
    const inboundAttachmentNotice = buildInboundAttachmentNotice(failures);
    const promptText = attachments.length
      ? renderPromptTextWithSavedAttachments(promptElements, attachments)
      : renderInboundMessageText(session, promptElements);
    const modelOptions = resolveChatModelOptions(settings, decision.chatKey);
    return {
      version: 1,
      chatKey: decision.chatKey,
      text: inboundAttachmentNotice
        ? `${promptText}\n\n${inboundAttachmentNotice}`
        : promptText,
      attachments,
      promptMeta: buildChatMessagePromptMeta({
        session,
        identity,
        chatKey: decision.chatKey,
        chatType: decision.chatType,
        requiresMentionToStartTurn: decision.requiresMentionToStartTurn,
        attachments,
      }),
      incomingMessageId: messageId || undefined,
      replyToMessageId: messageId || undefined,
      sessionFile: undefined,
      model: modelOptions.model,
      thinkingLevel: modelOptions.thinkingLevel,
      receivedAt,
    };
  };

  const handlePreparedChatTurnSubmission = async (
    submission: FrozenChatTurnSubmission,
    options: { startupRecoveryEstimatedBytes?: number } = {},
  ) => {
    const controller = getController(submission.chatKey);
    const submitToPi = async () => {
      await controller.runTurn({
        text: submission.text,
        attachments: submission.attachments,
        promptMeta: submission.promptMeta,
        replyToMessageId: submission.replyToMessageId,
        incomingMessageId: submission.incomingMessageId,
        sessionFile: submission.sessionFile,
        model: submission.model,
        thinkingLevel: submission.thinkingLevel,
        receivedAt: submission.receivedAt,
      });
    };
    if (options.startupRecoveryEstimatedBytes) {
      await runStartupRecoveryWithAdmission({
        admission: startupRecoveryAdmission,
        estimatedBytes: options.startupRecoveryEstimatedBytes,
        label: submission.sessionFile,
        preconnect: async () => {
          await controller.connect({
            restoreSessionFile: submission.sessionFile,
          });
        },
        resume: submitToPi,
      });
    } else {
      await submitToPi();
    }
    return { disposition: "actionable" as const };
  };

  let requestReconcileChatInbox: () => void = () => {};
  const claimedInboxJobs = new Map<string, ClaimedChatInboxJob>();
  const claimedInboxClaimLost = new Map<string, () => void>();
  const forgetClaimedInboxJob = (job: ClaimedChatInboxJob) => {
    if (claimedInboxJobs.get(job.envelope.itemId) === job) {
      claimedInboxJobs.delete(job.envelope.itemId);
    }
  };
  const releaseClaimedInboxJob = (job: ClaimedChatInboxJob) => {
    if (!chatBridgeStopping) {
      touchClaimedChatInboxItem(runtime.agentDir, job.envelope, {
        leaseMs: CHAT_INBOX_POLL_INTERVAL_MS * 2,
      });
    }
    forgetClaimedInboxJob(job);
  };
  const finishClaimedInboxJob = (
    job: ClaimedChatInboxJob,
    result?: ChatInboxJobResult,
  ) => {
    try {
      if (!result) {
        releaseClaimedInboxJob(job);
        return;
      }
      finalizeClaimedChatInboxJob(runtime.agentDir, job, result);
    } finally {
      forgetClaimedInboxJob(job);
    }
  };

  const outboxTurnFenceForClaimedJob = (
    job: ClaimedChatInboxJob,
  ): ChatOutboxTurnFence => ({
    agentDir: runtime.agentDir,
    turnId: job.envelope.itemId,
    chatKey: job.envelope.chatKey,
    messageId: job.envelope.messageId,
    ownerEpoch: job.envelope.ownerEpoch,
    attempt: job.envelope.attemptCount,
  });

  const runClaimedInboxJob = async (
    job: ClaimedChatInboxJob,
    run: () => Promise<ChatInboxJobResult | undefined>,
  ) => {
    const fence = outboxTurnFenceForClaimedJob(job);
    if (!touchClaimedChatInboxItem(runtime.agentDir, job.envelope)) {
      forgetClaimedInboxJob(job);
      return;
    }
    let claimLost = false;
    let resolveClaimLost!: () => void;
    const claimLostPromise = new Promise<undefined>((resolve) => {
      resolveClaimLost = () => resolve(undefined);
    });
    const loseClaim = () => {
      if (claimLost) return;
      claimLost = true;
      clearInterval(heartbeat);
      const controller = controllers.get(job.envelope.chatKey);
      if (controller?.ownsOutboxTurnFence(fence)) {
        void controller
          .terminateSession()
          .catch(() => {})
          .finally(() => {
            controller.dispose();
            if (controllers.get(job.envelope.chatKey) === controller) {
              controllers.delete(job.envelope.chatKey);
            }
          });
      }
      resolveClaimLost();
    };
    claimedInboxClaimLost.set(job.envelope.itemId, loseClaim);
    const heartbeat = setInterval(() => {
      try {
        if (!touchClaimedChatInboxItem(runtime.agentDir, job.envelope)) {
          const current = getChatInboxItem(
            runtime.agentDir,
            job.envelope.itemId,
          );
          if (!current || current.state !== "terminal") {
            logger.warn(
              `chat inbox heartbeat lost claim chatKey=${job.envelope.chatKey} turn=${job.envelope.itemId}`,
            );
          }
          loseClaim();
        }
      } catch (error) {
        logger.warn(
          `chat inbox heartbeat failed chatKey=${job.envelope.chatKey} turn=${job.envelope.itemId} err=${safeString((error as any)?.message || error)}`,
        );
      }
    }, CHAT_INBOX_PROCESSING_HEARTBEAT_MS);
    try {
      const result = await Promise.race([
        runWithChatOutboxTurnFence(fence, run),
        claimLostPromise,
      ]);
      if (claimLost) return;
      finishClaimedInboxJob(job, result);
    } catch (error) {
      logger.warn(
        `chat inbox worker detached without terminal chatKey=${job.envelope.chatKey} turn=${job.envelope.itemId} err=${safeString((error as any)?.message || error)}`,
      );
      releaseClaimedInboxJob(job);
    } finally {
      clearInterval(heartbeat);
      claimedInboxClaimLost.delete(job.envelope.itemId);
      forgetClaimedInboxJob(job);
    }
  };

  const prepareClaimedInboxJob = async (
    job: ClaimedChatInboxJob,
  ): Promise<PreparedChatKeyWorkerJob> => {
    const { envelope } = job;
    const queuedSession = restoreChatInboxSession(
      envelope,
      findRuntimeBot(
        safeString(envelope?.session?.platform).trim(),
        safeString(envelope?.session?.selfId).trim(),
      ),
    );
    const queuedElements = restoreChatInboxElements(envelope);
    const queuedChatKey =
      safeString(envelope.chatKey).trim() || sessionChatKey(queuedSession);
    const identity = getIdentity();

    const recordOnlyJob = (): PreparedChatKeyWorkerJob => ({
      run: () =>
        runClaimedInboxJob(job, async () => ({
          disposition: "record_only",
        })),
    });
    const requireCommittedAdmission = (
      admission: ChatInboxAdmission | null,
    ) => {
      if (!admission) {
        throw new Error("chat_inbox_claim_lost_during_admission");
      }
      return admission;
    };
    const prepareFromAdmission = (
      admission: ChatInboxAdmission,
      recoverCommittedWork = false,
    ): PreparedChatKeyWorkerJob => {
      const resolved = resolveDurableChatAdmission(admission, {
        chatKey: envelope.chatKey,
        messageId: envelope.messageId,
      });
      switch (resolved.kind) {
        case "record_only":
          return recordOnlyJob();
        case "command":
          if (recoverCommittedWork) {
            throw new Error("chat_command_recovery_requires_durable_result");
          }
          return {
            run: () =>
              runClaimedInboxJob(job, () =>
                handleCommandSession(
                  resolved.command,
                  resolved.promptMeta,
                  resolved.chatKey,
                  resolved.messageId,
                  outboxTurnFenceForClaimedJob(job),
                  envelope.createdAt,
                ),
              ),
          };
        case "unmatched_command":
          if (recoverCommittedWork) {
            throw new Error("chat_command_recovery_requires_durable_result");
          }
          return {
            run: () =>
              runClaimedInboxJob(job, () =>
                handleUnmatchedCommandSession(
                  resolved.name,
                  resolved.chatKey,
                  resolved.messageId,
                  resolved.respond,
                ),
              ),
          };
        case "turn":
          return {
            run: () =>
              runClaimedInboxJob(job, () =>
                handlePreparedChatTurnSubmission(resolved.submission, {
                  startupRecoveryEstimatedBytes:
                    job.startupRecoveryEstimatedBytes,
                }),
              ),
          };
        case "unavailable":
          throw new Error(`chat_inbox_admission_required:${resolved.reason}`);
        case "unclassified":
          throw new Error("chat_inbox_admission_required");
      }
    };

    const commitAdmission = (input: DurableChatAdmissionCommit) =>
      prepareFromAdmission(
        requireCommittedAdmission(
          commitClaimedChatInboxAdmission(runtime.agentDir, envelope, input),
        ),
      );

    const recoveredAdmission = resolveDurableChatAdmission(envelope.admission, {
      chatKey: envelope.chatKey,
      messageId: envelope.messageId,
    });
    if (recoveredAdmission.kind !== "unclassified") {
      return prepareFromAdmission(envelope.admission, true);
    }
    if (job.resumeOnly) {
      return {
        run: () => runClaimedInboxJob(job, async () => undefined),
      };
    }

    if (isRecordOnlyChatKey(queuedChatKey)) {
      return commitAdmission({
        state: "record_only",
        decision: { version: 1, kind: "record_only_chat" },
      });
    }
    const commandRequest = parseInboundCommandRequest(
      queuedSession,
      elementsToCommandText(queuedElements),
      commandRows,
    );
    if (
      commandRequest.commandLike &&
      REMOVED_CHAT_COMMAND_NAMES.has(commandRequest.name)
    ) {
      return commitAdmission({
        state: "record_only",
        decision: {
          version: 1,
          kind: "removed_command",
          name: commandRequest.name,
        },
      });
    }
    const decision = await shouldProcessText(
      queuedSession,
      queuedElements,
      identity,
      {
        chatKey: queuedChatKey,
        addressedToAgent: commandRequest.commandLike,
      },
    );
    const commandTrust = decision.trust;
    if (commandRequest.commandLike && !decision.allow) {
      return commitAdmission({
        state: "record_only",
        decision: {
          version: 1,
          kind: "policy_rejected",
          decision: {
            source: "command_authorization",
            name: commandRequest.name,
          },
        },
      });
    }
    if (commandRequest.command) {
      return commitAdmission({
        state: "actionable",
        decision: {
          version: 1,
          kind: "command",
          chatKey: queuedChatKey,
          messageId: envelope.messageId,
          command: commandRequest.command,
          trust: commandTrust,
          promptMeta: buildCommandPromptMeta(queuedSession, commandTrust),
        },
      });
    }
    if (commandRequest.commandLike) {
      return commitAdmission({
        state: "actionable",
        decision: {
          version: 1,
          kind: "unmatched_command",
          chatKey: queuedChatKey,
          messageId: envelope.messageId,
          name: commandRequest.name,
          trust: commandTrust,
          respond: await isEffectivePrivateChatSession(queuedSession, identity),
        },
      });
    }

    if (!decision.allow || isRecordOnlyChatKey(decision.chatKey)) {
      return commitAdmission({
        state: "record_only",
        decision: {
          version: 1,
          kind: decision.allow ? "record_only_chat" : "policy_rejected",
          decision,
        },
      });
    }
    const submission = await prepareAllowedChatTurnSubmission(
      queuedSession,
      queuedElements,
      identity,
      decision,
      envelope.createdAt,
    );
    return commitAdmission({
      state: "actionable",
      decision: { version: 1, kind: "message", decision },
      submission,
    });
  };

  let requestDrainChatInbox: () => void = () => {};
  const startupRecoveryChatKeys = new Set<string>();
  const chatKeyWorkers = createChatKeyWorkerPool<ClaimedChatInboxJob>({
    prepare: (job) => prepareClaimedInboxJob(job),
    onPrepareError: (job, chatKey, error) => {
      logger.warn(
        `chat inbox prepare error; leaving inbox running chatKey=${chatKey} turn=${job.envelope.itemId} err=${safeString((error as any)?.message || error)}`,
      );
      releaseClaimedInboxJob(job);
    },
    onIdle: (chatKey: string) => {
      if (startupRecoveryChatKeys.delete(chatKey)) {
        app.completeInboundRecoveryChat(chatKey);
      }
      requestDrainChatInbox();
    },
    logger,
  });

  const enqueueClaimedInboxItem = (job: ClaimedChatInboxJob) => {
    claimedInboxJobs.set(job.envelope.itemId, job);
    if (chatBridgeStopping) {
      releaseClaimedInboxJob(job);
      return;
    }
    chatKeyWorkers.enqueue(job.envelope.chatKey, job);
  };

  const inboxDrain = createChatInboxDrain({
    agentDir: runtime.agentDir,
    getController,
    isInboundMessageProcessed,
    enqueueClaimedInboxItem,
    isChatKeyBlocked: (chatKey) => app.isInboundRecoveryChat(chatKey),
    hasActiveChatKeyWorker: (chatKey) => chatKeyWorkers.hasWorker(chatKey),
    isPriorityDuringActiveChatKeyWorker: (envelope) => {
      const frozenCommand =
        envelope.admission.state === "actionable" &&
        envelope.admission.decision?.kind === "command"
          ? (envelope.admission.decision.command as any)
          : undefined;
      if (frozenCommand) {
        return isActiveChatKeyPriorityCommand(
          safeString(frozenCommand.name).trim(),
        );
      }
      const queuedSession = restoreChatInboxSession(
        envelope,
        findRuntimeBot(
          safeString(envelope?.session?.platform || "").trim(),
          safeString(envelope?.session?.selfId || "").trim(),
        ),
      );
      const commandRequest = parseInboundCommandRequest(
        queuedSession,
        elementsToCommandText(restoreChatInboxElements(envelope)),
        commandRows,
      );
      return isActiveChatKeyPriorityCommand(commandRequest.command?.name || "");
    },
    canClaimDuringActiveChatKeyWorker: (envelope) => {
      const admitted = resolveDurableChatAdmission(envelope.admission, {
        chatKey: envelope.chatKey,
        messageId: envelope.messageId,
      });
      if (admitted.kind !== "unclassified") {
        return (
          admitted.kind === "turn" ||
          (admitted.kind === "command" &&
            isActiveChatKeyPriorityCommand(admitted.command.name))
        );
      }

      const queuedSession = restoreChatInboxSession(
        envelope,
        findRuntimeBot(
          safeString(envelope?.session?.platform || "").trim(),
          safeString(envelope?.session?.selfId || "").trim(),
        ),
      );
      const queuedChatKey =
        safeString(envelope.chatKey).trim() || sessionChatKey(queuedSession);
      if (isRecordOnlyChatKey(queuedChatKey)) return false;
      const commandRequest = parseInboundCommandRequest(
        queuedSession,
        elementsToCommandText(restoreChatInboxElements(envelope)),
        commandRows,
      );
      const commandName = commandRequest.command?.name || "";
      if (!commandName) return true;
      if (!isActiveChatKeyPriorityCommand(commandName)) return false;
      return resolveChatInputAccess(queuedSession, getIdentity(), {
        addressedToAgent: true,
      }).then((access) => access.allow);
    },
    logger,
  });

  requestDrainChatInbox = () => {
    if (chatBridgeStopping) return;
    inboxDrain.requestDrainChatInbox();
  };
  requestReconcileChatInbox = () => {
    if (chatBridgeStopping) return;
    for (const envelope of listRunningChatInboxItems(runtime.agentDir)) {
      if (claimedInboxJobs.has(envelope.itemId)) continue;
      if (chatKeyWorkers.hasWorker(envelope.chatKey)) continue;
      const reclaimed = reclaimRunningChatInboxItem(runtime.agentDir, envelope);
      if (reclaimed) {
        enqueueClaimedInboxItem({ envelope: reclaimed, resumeOnly: true });
      }
    }
    requestDrainChatInbox();
  };

  app.on("inbound-recovery-chat-ready", () => {
    requestDrainChatInbox();
  });

  app.on("message", (session: any) => {
    void (async () => {
      const identity = getIdentity();
      const elements = ensureSessionElements(session);
      try {
        const chatKey = sessionChatKey(session);
        enrichInboundMessageMetadata(
          runtime.agentDir,
          session,
          elements,
          identity,
          trustOf,
          { chatKey },
        );
        const logEntry = buildInboundChatLogInput(session, elements, {
          timestamp: nowIso(),
          chatKey,
        });
        if (logEntry) {
          appendChatLog(runtime.agentDir, logEntry);
        }
      } catch (error: any) {
        logger.warn(
          `chat inbound save failed err=${safeString(error?.message || error)}`,
        );
      }

      if (chatBridgeStopping) {
        logger.info(
          "chat inbound accepted while bridge stopping; leaving pending for next startup",
        );
        return;
      }
      requestDrainChatInbox();
    })().catch((error: any) => {
      logger.warn(
        `chat inbound handling failed err=${safeString(error?.message || error)}`,
      );
    });
  });

  app.on("bot-status-updated", (bot: any) => {
    if (bot?.status !== 1) return;
    void syncTelegramCommands(app, logger, commandRows);
    void syncDiscordCommands(app, logger, commandRows);
  });

  const startedAt = nowIso();
  const send = async (
    payload: ChatOutboxPayloadInput,
    options: {
      waitUntilDeliverySettled?: boolean;
      waitForDeliveryMs?: number;
      idempotencyKey?: string;
    } = {},
  ) => {
    const result = await enqueueAndDrainOutbox(payload, "generic", {
      idempotencyKey: safeString(options.idempotencyKey).trim() || undefined,
    });
    const settledMessageIds =
      result.status === "delivered"
        ? result.deliveryResult || []
        : result.status === "dispatched" &&
            (options.waitUntilDeliverySettled ||
              Number.isFinite(options.waitForDeliveryMs))
          ? await waitForChatOutboxDelivery(
              runtime.agentDir,
              result.id,
              options.waitForDeliveryMs,
            )
          : null;
    return settledMessageIds
      ? {
          delivered: true as const,
          messageIds: settledMessageIds,
        }
      : {
          delivered: false as const,
          pending: true as const,
          outboxId: result.id,
          ...(result.deliveryResult?.length
            ? { messageIds: result.deliveryResult }
            : {}),
        };
  };
  const typing = async (payload: { chatKey?: string }) => {
    const chatKey = safeString(payload?.chatKey).trim();
    if (!chatKey) throw new Error("chat_key_required");
    return { sent: await sendTyping(app, chatKey, h) };
  };
  const react = async (payload: {
    chatKey?: string;
    messageId?: string;
    emoji?: string;
  }) => {
    const chatKey = safeString(payload?.chatKey).trim();
    const messageId = safeString(payload?.messageId).trim();
    const emoji = safeString(payload?.emoji).trim();
    if (!chatKey) throw new Error("chat_key_required");
    if (!messageId) throw new Error("chat_message_id_required");
    if (!emoji) throw new Error("chat_reaction_emoji_required");
    return { sent: await sendReaction(app, chatKey, messageId, emoji) };
  };
  const submitIncoming = async (input: any) => {
    const chatKey = safeString(input?.chatKey).trim();
    const text = safeString(input?.text);
    const taskName = safeString(input?.taskName).trim();
    const parsed = parseChatKey(chatKey);
    if (!chatKey || !text.trim() || !parsed) {
      throw new Error("chat_inbox_message_identity_required");
    }
    const timestamp = Date.now();
    const session = {
      platform: parsed.platform,
      selfId: parsed.botId || "",
      guildId: parsed.botId || undefined,
      channelId: parsed.chatId,
      chatId: parsed.chatId,
      userId: "scheduled-message",
      username: "Scheduled message",
      type: parsed.botId ? "group" : "private",
      timestamp,
      content: text,
    };
    const promptMeta = buildChatMessagePromptMeta({
      session,
      identity: getIdentity(),
      chatKey,
      chatType: getChatType(session),
      attachments: [],
      task: { id: input?.taskId, name: taskName },
    });
    const deliveryIdempotencyKey =
      safeString(input?.deliveryIdempotencyKey).trim() || undefined;
    const deliverFinal = input?.deliverFinal !== false;
    const quietMode = input?.quietMode === true;
    let messageId: string;
    if (input?.showInput !== false) {
      const displayText = taskName
        ? `⏰ Scheduled task · ${taskName}\n${text}`
        : text;
      const delivery = await enqueueAndDrainOutbox(
        {
          chatKey,
          createdAt: new Date(timestamp).toISOString(),
          parts: [{ type: "text", text: displayText }],
          incomingMessage: {
            text,
            session,
            promptMeta,
            deliverFinal,
            quietMode,
          },
        },
        "generic",
        { idempotencyKey: deliveryIdempotencyKey },
      );
      messageId = safeString(delivery.deliveryResult?.[0]).trim();
      if (!messageId) throw new Error("chat_send_message_empty_result");
    } else {
      const identity =
        deliveryIdempotencyKey || `${chatKey}:${input?.taskId}:${timestamp}`;
      messageId = `rin-incoming-${crypto
        .createHash("sha256")
        .update(identity)
        .digest("hex")
        .slice(0, 24)}`;
      enqueueChatInboxItem(runtime.agentDir, {
        chatKey,
        messageId,
        session: { ...session, messageId },
        elements: [{ type: "text", text }],
        preparedAdmission: {
          decision: {
            allow: true,
            reason: "prepared_incoming_message",
            chatKey,
          },
          submission: {
            version: 1,
            chatKey,
            text,
            attachments: [],
            promptMeta,
            deliverFinal,
            quietMode,
            incomingMessageId: messageId,
            replyToMessageId: messageId,
            receivedAt: new Date(timestamp).toISOString(),
          },
        },
      });
    }
    const item = getChatInboxItemByMessageId(
      runtime.agentDir,
      chatKey,
      messageId,
    );
    if (!item) throw new Error("chat_inbox_turn_commit_failed");
    requestDrainChatInbox();
    for (;;) {
      const current = getChatInboxItem(runtime.agentDir, item.itemId);
      if (!current) throw new Error("chat_inbox_turn_commit_failed");
      if (current.state === "failed") {
        throw new Error(current.lastError || "chat_inbox_turn_commit_failed");
      }
      if (current.state === "terminal") {
        return { turnId: current.itemId, messageId };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const runTurn = async (payload: ChatBridgeTurnPayload) => {
    const chatKey = safeString(payload?.chatKey).trim();
    const text = safeString(payload?.text).trim();
    const { sessionFile } = normalizeSessionRef(payload);
    const controllerKey =
      safeString(payload?.controllerKey).trim() || "default";
    const affectChatBinding = payload?.affectChatBinding !== false;
    const linkDeliveriesToSession =
      payload?.linkDeliveriesToSession ?? affectChatBinding;
    const disposeAfterTurn = payload?.disposeAfterTurn === true;
    const shutdownAfterTurn = payload?.shutdownAfterTurn === true;
    if (!text) throw new Error("chat_text_required");
    const useBoundController = Boolean(
      chatKey && controllerKey === "default" && affectChatBinding,
    );
    const controller = useBoundController
      ? getController(chatKey)
      : getDetachedController(controllerKey, {
          chatKey,
          affectChatBinding,
          linkDeliveriesToSession,
          frontendIdentity: normalizeFrontendIdentity(payload?.frontend),
        });
    if (!useBoundController) {
      detachedControllerUsers.set(
        controller,
        (detachedControllerUsers.get(controller) || 0) + 1,
      );
    }
    try {
      const chatModelOptions = chatKey
        ? resolveChatModelOptions(settings, chatKey)
        : {};
      return await controller.runTurn({
        text,
        attachments: [],
        replyToMessageId:
          safeString(payload?.replyToMessageId).trim() || undefined,
        sessionFile,
        sessionName: payload?.sessionName,
        managedSessionLeaf: payload?.managedSessionLeaf,
        createSessionFileIfMissing: payload?.createSessionFileIfMissing,
        tools: payload?.tools,
        excludeTools: payload?.excludeTools,
        noTools: payload?.noTools,
        disabledRinCapabilities: payload?.disabledRinCapabilities,
        ...chatModelOptions,
        model: safeString(payload?.model).trim() || chatModelOptions.model,
        thinkingLevel:
          safeString(payload?.thinkingLevel).trim() ||
          chatModelOptions.thinkingLevel,
        piStartupOptions: payload?.piStartupOptions,
        promptMeta: payload?.promptMeta,
        requestTag: payload?.requestTag,
        deliveryIdempotencyKey: payload?.deliveryIdempotencyKey,
        deliverFinal: payload?.deliverFinal,
        quietMode: payload?.quietMode,
      });
    } finally {
      if (!useBoundController) {
        if (shutdownAfterTurn) {
          detachedControllerCleanup.set(controller, "shutdown");
        } else if (
          disposeAfterTurn &&
          detachedControllerCleanup.get(controller) !== "shutdown"
        ) {
          detachedControllerCleanup.set(controller, "dispose");
        }
        const remainingUsers = Math.max(
          0,
          (detachedControllerUsers.get(controller) || 1) - 1,
        );
        if (remainingUsers) {
          detachedControllerUsers.set(controller, remainingUsers);
        } else {
          detachedControllerUsers.delete(controller);
          const cleanup = detachedControllerCleanup.get(controller);
          const isCurrent =
            detachedControllers.get(controllerKey) === controller;
          if (retiredDetachedControllers.has(controller) || cleanup) {
            if (cleanup === "shutdown") {
              await controller.terminateSession().catch((error: any) => {
                logger.warn(
                  `chat detached turn shutdown failed controllerKey=${controllerKey} err=${safeString(error?.message || error)}`,
                );
              });
            } else {
              controller.dispose();
            }
            retiredDetachedControllers.delete(controller);
            detachedControllerCleanup.delete(controller);
            if (isCurrent) {
              detachedControllers.delete(controllerKey);
              detachedControllerSignatures.delete(controllerKey);
            }
            if (cleanup) {
              try {
                fs.rmSync(path.dirname(controller.statePath), {
                  recursive: true,
                  force: true,
                });
              } catch {}
            }
          }
        }
      }
    }
  };
  const terminateTurn = async (payload: {
    controllerKey?: string;
    chatKey?: string;
  }) => {
    const controllerKey = safeString(payload?.controllerKey).trim();
    const chatKey = safeString(payload?.chatKey).trim();
    if (!controllerKey && !chatKey)
      throw new Error("chat_controller_key_required");
    if (chatKey) {
      const controller = controllers.get(chatKey);
      if (!controller) return { terminated: false };
      await controller.terminateSession().catch(() => {});
      controller.dispose();
      controllers.delete(chatKey);
      return { terminated: true, chatKey };
    }
    const controller = detachedControllers.get(controllerKey);
    if (!controller) return { terminated: false };
    await controller.terminateSession().catch(() => {});
    controller.dispose();
    detachedControllers.delete(controllerKey);
    detachedControllerSignatures.delete(controllerKey);
    return { terminated: true, controllerKey };
  };
  const evalBridge = async (payload: ChatBridgeEvalPayload) => {
    const startedAtMs = Date.now();
    const currentChatKey =
      safeString(payload?.currentChatKey).trim() || undefined;
    const requestId = safeString(payload?.requestId).trim() || undefined;
    const code = safeString(payload?.code);
    const session = normalizeSessionRef(payload);
    const runtimeContext = createChatBridgeRuntime({
      app,
      agentDir: runtime.agentDir,
      dataDir,
      currentChatKey,
      h,
      requestId,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
    });
    let auditPath = "";
    try {
      const result = await executeChatBridgeCode({
        code,
        context: runtimeContext,
        timeoutMs: payload?.timeoutMs,
        filename: `${currentChatKey || "chat"}:${requestId || "bridge"}.ts`,
      });
      auditPath = appendChatBridgeAudit(runtime.agentDir, {
        timestamp: nowIso(),
        ok: true,
        currentChatKey,
        requestId,
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
        timeoutMs: result.timeoutMs,
        durationMs: Date.now() - startedAtMs,
        code,
        result: result.value,
      });
      return {
        ok: true,
        currentChatKey,
        requestId,
        timeoutMs: result.timeoutMs,
        durationMs: Date.now() - startedAtMs,
        auditPath,
        value: result.value,
        text: renderChatBridgeResult(result.value),
      };
    } catch (error: any) {
      auditPath = appendChatBridgeAudit(runtime.agentDir, {
        timestamp: nowIso(),
        ok: false,
        currentChatKey,
        requestId,
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
        durationMs: Date.now() - startedAtMs,
        code,
        error: safeString(error?.stack || error?.message || error).trim(),
      });
      throw new Error(
        `${safeString(error?.message || error).trim() || "chat_bridge_failed"}${auditPath ? `\naudit=${auditPath}` : ""}`,
      );
    }
  };

  reconcileCommittedChatOutboxProcessing(runtime.agentDir);
  const startupRecoverableProcessing = listRunningChatInboxItems(
    runtime.agentDir,
  )
    .flatMap((envelope) => {
      const reclaimed = reclaimRunningChatInboxItem(
        runtime.agentDir,
        envelope,
        {
          force: true,
        },
      );
      if (!reclaimed) return [];
      const storedSessionFile =
        reclaimed.admission.executionSessionFile ||
        reclaimed.admission.submission?.sessionFile;
      const sessionFile =
        resolveStoredSessionFile(runtime.agentDir, storedSessionFile) ||
        safeString(storedSessionFile).trim();
      let sessionFileBytes = 0;
      try {
        sessionFileBytes = sessionFile ? fs.statSync(sessionFile).size : 0;
      } catch {}
      return [
        {
          envelope: reclaimed,
          estimatedBytes: estimateStartupRecoveryMemoryBytes(sessionFileBytes),
        },
      ];
    })
    .sort((left, right) => right.estimatedBytes - left.estimatedBytes);
  for (const { envelope } of startupRecoverableProcessing) {
    if (startupRecoveryChatKeys.has(envelope.chatKey)) continue;
    startupRecoveryChatKeys.add(envelope.chatKey);
    app.beginInboundRecoveryChat(envelope.chatKey);
  }
  try {
    await app.start();
    await syncTelegramCommands(app, logger, commandRows);
    await syncDiscordCommands(app, logger, commandRows);
  } catch (error) {
    await cleanupFailedStartup();
    throw error;
  }
  typingPollTimer = setInterval(() => {
    for (const controller of controllers.values()) {
      void controller.pollTyping().catch(() => {});
    }
    for (const controller of detachedControllers.values()) {
      void controller.housekeep().catch(() => {});
    }
  }, TYPING_POLL_INTERVAL_MS);
  logger.info(
    `chat bridge started bots=${JSON.stringify(app.bots.map((bot: any) => ({ platform: bot.platform, selfId: bot.selfId, status: bot.status })))}`,
  );

  for (const { envelope, estimatedBytes } of startupRecoverableProcessing) {
    enqueueClaimedInboxItem({
      envelope,
      resumeOnly: true,
      startupRecoveryEstimatedBytes: estimatedBytes,
    });
  }
  if (startupRecoverableProcessing.length) {
    logger.info(
      `chat inbox startup recovering processing=${startupRecoverableProcessing.length}`,
    );
  }

  requestReconcileChatInbox();
  requestReconcileChatTerminals();
  inboxPollTimer = setInterval(() => {
    try {
      requestReconcileChatInbox();
      requestReconcileChatTerminals();
    } catch (error) {
      logger.warn(
        `chat inbox reconciliation failed err=${safeString((error as any)?.message || error)}`,
      );
    }
  }, CHAT_INBOX_POLL_INTERVAL_MS);
  runOutboxHistoryCleanup();
  outboxHistoryCleanupTimer = setInterval(
    () => runOutboxHistoryCleanup(),
    CHAT_OUTBOX_HISTORY_CLEANUP_INTERVAL_MS,
  );
  requestDrainChatOutbox();
  outboxPollTimer = setInterval(
    () => requestDrainChatOutbox(),
    CHAT_OUTBOX_POLL_INTERVAL_MS,
  );

  let stoppingPromise: Promise<void> | null = null;
  const stop = async () => {
    if (stoppingPromise) return await stoppingPromise;
    stoppingPromise = (async () => {
      chatBridgeStopping = true;
      if (typingPollTimer) clearInterval(typingPollTimer);
      if (inboxPollTimer) clearInterval(inboxPollTimer);
      if (outboxPollTimer) clearInterval(outboxPollTimer);
      if (outboxHistoryCleanupTimer) clearInterval(outboxHistoryCleanupTimer);
      await terminalRecoveryClient?.disconnect().catch(() => {});
      for (const job of [...claimedInboxJobs.values()]) {
        releaseClaimedInboxJob(job);
      }
      for (const controller of controllers.values()) {
        if (options.hosted === true) {
          await controller.detachForDaemonShutdown().catch(() => {});
        } else {
          controller.dispose();
        }
      }
      const detachedControllersToStop = new Set([
        ...detachedControllers.values(),
        ...retiredDetachedControllers,
      ]);
      for (const controller of detachedControllersToStop) {
        if (options.hosted === true) {
          await controller.detachForDaemonShutdown().catch(() => {});
        } else {
          controller.dispose();
        }
      }
      retiredDetachedControllers.clear();
      try {
        await app.stop();
      } catch {}
      try {
        await inboundHttpTransport?.close();
      } catch {}
    })();
    return await stoppingPromise;
  };
  const getStatus = (): ChatBridgeStatus => {
    const adapters = app.getPlatformStatuses();
    return {
      ready: true,
      status: adapters.some((adapter: any) => adapter.status === "degraded")
        ? "degraded"
        : "ready",
      startedAt,
      settingsPath,
      adapterCount: adapters.length,
      botCount: Array.isArray(app.bots) ? app.bots.length : 0,
      controllerCount: controllers.size,
      detachedControllerCount: detachedControllers.size,
      adapters,
      stopping: chatBridgeStopping,
    };
  };

  return {
    app,
    options,
    stop,
    getStatus,
    send,
    typing,
    react,
    runTurn,
    submitIncoming,
    terminateTurn,
    evalBridge,
  };
}
