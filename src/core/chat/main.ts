#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
  canRunCommand,
  chatStateDir,
  listChatStateFiles,
  listDetachedControllerStateFiles,
} from "./support.js";
import {
  drainChatOutbox,
  getChatCommandRows,
  reconcileCommittedChatOutboxProcessing,
  syncDiscordCommands,
  syncTelegramCommands,
} from "./boot.js";
import {
  elementsToText,
  ensureDir,
  ensureSessionElements,
  extractInboundAttachments,
  buildInboundAttachmentNotice,
  getChatId,
  getChatType,
  lookupReplySession,
  enrichInboundMessageMetadata,
  pickChatName,
  pickMessageId,
  pickReplyToMessageId,
  pickSenderNickname,
  pickUnsessionedOwnQuoteText,
  pickUserId,
  prependQuoteTextToPromptBody,
  renderInboundMessageText,
  renderPromptTextWithSavedAttachments,
  safeString,
  hasInboundChatMessageReplyBoundary,
  isInboundChatMessageProcessed,
  isReplyToLatestAssistantMessage,
  markProcessedChatMessage,
} from "./chat-helpers.js";
import { buildInboundChatLogInput } from "./inbound-normalization.js";
import { withoutChatQuoteNodes } from "./rich-text.js";
import { buildChatMessageRecordKey } from "./message-store.js";
import { ChatController, loadChatSettings } from "./controller.js";
import { readChatCommandResponses } from "./command-responses.js";
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
  commitClaimedChatInboxAdmission,
  getChatInboxItem,
  releaseClaimedChatInboxItem,
  restoreChatInboxElements,
  restoreChatInboxSession,
  restoreProcessingChatInboxItems,
  touchClaimedChatInboxItem,
} from "./inbox.js";
import {
  type ClaimedChatInboxJob,
  type ChatInboxJobResult,
  createChatInboxDrain,
  finalizeClaimedChatInboxJob,
  requeueClaimedChatInboxJob,
} from "./inbox-drain.js";
import {
  type PreparedChatKeyWorkerJob,
  createChatKeyWorkerPool,
} from "./chat-key-worker.js";
import {
  isEffectivePrivateChatSession,
  shouldProcessText,
} from "./decision.js";
import {
  createChatRuntimeApp,
  createChatRuntimeH,
  instantiateChatRuntimeAdapters,
  instantiateExternalChatRuntimeAdapters,
  type ChatRuntimeExternalAdapterEntry,
} from "../chat-runtime/index.js";
import {
  ensureChatRuntimeDependencies,
  listChatRuntimeAdapterEntries,
} from "./runtime-config.js";
import { composeChatKeyForBot, loadIdentity, trustOf } from "./support.js";
import type { PromptContextMeta } from "../rin-frontend-sdk/prompt-context.js";
import {
  normalizeFrontendIdentity,
  type RinFrontendIdentity,
} from "../rin-frontend-sdk/frontend-identity.js";
import { isRinFrontendTurnCancelledError } from "../rin-frontend-sdk/lifecycle-errors.js";
import type { RinToolStartupOptions } from "../rin-lib/tool-options.js";
import type { RinPiPassthroughOptions } from "../rin-lib/pi-passthrough.js";
import {
  cleanupChatOutboxHistory,
  enqueueChatOutboxPayload,
  hasCommittedTerminalChatOutbox,
  withChatQuotePart,
  runWithChatOutboxTurnFence,
  type ChatOutboxPayloadInput,
  type ChatOutboxTurnFence,
  type EnqueueChatOutboxOptions,
} from "../rin-lib/chat-outbox.js";
import {
  sendReaction,
  sendTyping,
  validateChatOutboxPayloadForDispatch,
} from "./transport.js";
import { normalizeSessionRef } from "../session/ref.js";

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
    disposeAfterTurn?: boolean;
    shutdownAfterTurn?: boolean;
    deliverFinal?: boolean;
    quietMode?: boolean;
    text: string;
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
  app: any;
  options: {
    additionalExtensionPaths?: string[];
    hosted?: boolean;
    frontendClientFactory?: () => RinFrontendTurnClient;
    chatAdapterProviders?: ChatRuntimeExternalAdapterEntry[];
  };
  stop: () => Promise<void>;
  getStatus: () => ChatBridgeStatus;
  send: (
    payload: ChatOutboxPayloadInput,
  ) => Promise<
    { delivered: true } | { delivered: false; pending: true; outboxId: string }
  >;
  typing: (payload: { chatKey?: string }) => Promise<{ sent: boolean }>;
  react: (payload: {
    chatKey?: string;
    messageId?: string;
    emoji?: string;
  }) => Promise<{ sent: boolean }>;
  runTurn: (payload: ChatBridgeTurnPayload) => Promise<any>;
  setWorkingVisible: (payload: {
    chatKey?: string;
    controllerKey?: string;
    visible?: boolean;
  }) => Promise<{ handled: boolean }>;
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
    chatAdapterProviders?: ChatRuntimeExternalAdapterEntry[];
    settingsPath?: string;
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

  const settings = loadChatSettings(settingsPath);

  const h = createChatRuntimeH();
  const app = createChatRuntimeApp(runtime.agentDir);
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
      deliveryKind === "error" && !payload.deliveryKind
        ? { ...payload, deliveryKind }
        : payload;
    await validateChatOutboxPayloadForDispatch(deliveryPayload, h);
    const outboxId = enqueueChatOutboxPayload(
      runtime.agentDir,
      deliveryPayload,
      {
        id,
        idempotencyKey: options.idempotencyKey,
        deliveryKind,
        turnTerminalKind: options.turnTerminalKind,
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
  const chatRuntimeRoot = path.join(dataDir, "chat-runtime");
  try {
    ensureChatRuntimeDependencies(chatRuntimeRoot, settings);
  } catch (error: any) {
    logger.warn(
      `chat runtime dependency install failed err=${String(error?.message || error)}`,
    );
  }
  await instantiateChatRuntimeAdapters(app, {
    dataDir,
    adapterEntries: listChatRuntimeAdapterEntries(settings),
    logger,
  });
  await instantiateExternalChatRuntimeAdapters(app, {
    agentDir: runtime.agentDir,
    dataDir,
    runtimeRoot: chatRuntimeRoot,
    h,
    adapterEntries: options.chatAdapterProviders || [],
    logger,
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
  const typingPollTimer = setInterval(() => {
    for (const controller of controllers.values()) {
      void controller.pollTyping().catch(() => {});
    }
    for (const controller of detachedControllers.values()) {
      void controller.housekeep().catch(() => {});
    }
  }, TYPING_POLL_INTERVAL_MS);
  const commandRows = getChatCommandRows();
  const chatCommandResponses = readChatCommandResponses(runtime.agentDir);
  const frontendClientFactory = options.frontendClientFactory;
  const getIdentity = () => loadIdentity(dataDir);
  const getController = (chatKey: string) => {
    let controller = controllers.get(chatKey);
    if (!controller) {
      controller = new ChatController(app, dataDir, chatKey, {
        logger,
        h,
        frontendClientFactory,
        commandResponses: chatCommandResponses,
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
      frontendIdentity?: RinFrontendIdentity;
    },
  ) => {
    const controllerChatKey =
      safeString(detachedOptions?.chatKey).trim() || `cron:${controllerKey}`;
    const affectChatBinding = detachedOptions?.affectChatBinding !== false;
    const signature = JSON.stringify({
      controllerChatKey,
      affectChatBinding,
      frontendIdentity: detachedOptions?.frontendIdentity || null,
      useChatFrontendIdentity: Boolean(detachedOptions?.chatKey),
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
        statePath,
        frontendClientFactory,
        sleepAfterIdleMs: DETACHED_CONTROLLER_SLEEP_IDLE_MS,
        commandResponses: chatCommandResponses,
        frontendIdentity: detachedOptions?.frontendIdentity,
        useChatFrontendIdentity: Boolean(detachedOptions?.chatKey),
      });
      detachedControllers.set(controllerKey, controller);
      detachedControllerSignatures.set(controllerKey, signature);
    }
    return controller;
  };
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
    if (!respond) return { retry: false };
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
    return { retry: false };
  };

  const buildCommandPromptMeta = (
    session: any,
    trust: string,
  ): PromptContextMeta => ({
    source: "chat-bridge",
    selfImproveEligible: true,
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
  ) => {
    if (command.name === "help") {
      const lines = commandRows.map(
        (entry) =>
          `/${entry.name}${entry.description ? ` — ${entry.description}` : ""}`,
      );
      await enqueueAndDrainOutbox(
        {
          createdAt: nowIso(),
          chatKey,
          parts: withChatQuotePart(
            [{ type: "text", text: lines.join("\n") }],
            messageId,
          ),
        },
        "command_ack",
        {
          idempotencyKey: messageId
            ? JSON.stringify(["help_command", chatKey, messageId])
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
      return { retry: false };
    }

    const controller = getController(chatKey);

    const text = `/${command.name}${command.argsText ? ` ${command.argsText}` : ""}`;
    try {
      await controller.runCommand(
        text,
        messageId,
        messageId,
        "",
        promptMeta,
        outboxTurnFence,
      );
      return { retry: false, disposition: "actionable" as const };
    } catch (error) {
      logger.warn(
        `chat command failed chatKey=${chatKey} command=${command.name} err=${safeString((error as any)?.message || error)}`,
      );
      return {
        retry: !hasCommittedTerminalChatOutbox(
          runtime.agentDir,
          chatKey,
          messageId,
        ),
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
    const quotedMessageId = pickReplyToMessageId(elements);
    const replySession = lookupReplySession(
      runtime.agentDir,
      decision.chatKey,
      quotedMessageId,
    );
    const linkedSessionFile = safeString(replySession?.sessionFile).trim();
    const quotedOwnMessageText = pickUnsessionedOwnQuoteText({
      senderUserId: pickUserId(session),
      linked: replySession?.linked,
      linkedSessionFile,
    });
    const shouldOmitPromptReplyTo =
      quotedOwnMessageText !== null ||
      isReplyToLatestAssistantMessage(
        runtime.agentDir,
        decision.chatKey,
        quotedMessageId,
      );
    const promptElements = shouldOmitPromptReplyTo
      ? withoutChatQuoteNodes(elements)
      : elements;
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
    const promptText = prependQuoteTextToPromptBody(
      attachments.length
        ? renderPromptTextWithSavedAttachments(promptElements, attachments)
        : renderInboundMessageText(session, promptElements),
      quotedOwnMessageText ?? "",
    );
    const modelOptions = resolveChatModelOptions(settings, decision.chatKey);
    return {
      version: 1,
      chatKey: decision.chatKey,
      text: inboundAttachmentNotice
        ? `${promptText}\n\n${inboundAttachmentNotice}`
        : promptText,
      attachments,
      promptMeta: {
        source: "chat-bridge",
        selfImproveEligible: true,
        sentAt: Number.isFinite(Number(session?.timestamp))
          ? Number(session.timestamp)
          : Date.now(),
        chatKey: decision.chatKey,
        chatName:
          pickChatName(session) ||
          (decision.chatType === "private" ? pickSenderNickname(session) : ""),
        chatType: decision.chatType,
        userId: pickUserId(session),
        nickname: pickSenderNickname(session),
        identity: trustOf(
          identity,
          safeString(session?.platform).trim(),
          pickUserId(session),
        ),
        runtimeMetadata:
          session?.runtimeMetadata &&
          typeof session.runtimeMetadata === "object"
            ? session.runtimeMetadata
            : undefined,
        requiresMentionToStartTurn:
          decision.requiresMentionToStartTurn || undefined,
        attachedFiles: attachments
          .filter((item) => item?.kind === "file")
          .map((item) => ({ name: item.name, path: item.path })),
      },
      incomingMessageId: messageId || undefined,
      replyToMessageId: messageId || undefined,
      sessionFile: linkedSessionFile || undefined,
      model: modelOptions.model,
      thinkingLevel: modelOptions.thinkingLevel,
      receivedAt,
    };
  };

  const handlePreparedChatTurnSubmission = async (
    submission: FrozenChatTurnSubmission,
  ) => {
    const messageId = safeString(submission.incomingMessageId).trim();
    const controller = getController(submission.chatKey);
    const handleTurnFailure = async (error: any) => {
      const errorMessage =
        safeString((error as any)?.message || error).trim() ||
        "Chat turn failed.";
      const messageProcessed = messageId
        ? isInboundChatMessageProcessed(
            runtime.agentDir,
            submission.chatKey,
            messageId,
          )
        : false;
      if (isRinFrontendTurnCancelledError(error)) {
        logger.info(
          `chat turn cancelled by frontend lifecycle chatKey=${submission.chatKey} err=${errorMessage}`,
        );
        return {
          retry: Boolean(messageId && !messageProcessed),
          errorMessage,
        };
      }
      if (chatBridgeStopping && messageId && !messageProcessed) {
        logger.info(
          `chat turn interrupted by bridge shutdown chatKey=${submission.chatKey} err=${errorMessage}`,
        );
        return { retry: true, errorMessage };
      }
      logger.warn(
        `chat turn failed chatKey=${submission.chatKey} err=${errorMessage}`,
      );
      if (errorMessage && messageId && !messageProcessed) {
        let terminalErrorCommitted = false;
        try {
          await enqueueAndDrainOutbox(
            {
              createdAt: nowIso(),
              chatKey: submission.chatKey,
              parts: withChatQuotePart(
                [{ type: "text", text: errorMessage }],
                messageId,
              ),
              sessionFile: submission.sessionFile,
            },
            "error",
            {
              id: `error-${buildChatMessageRecordKey(submission.chatKey, messageId)}`,
              idempotencyKey: JSON.stringify([
                "error",
                submission.chatKey,
                messageId,
              ]),
              postDelivery: {
                markProcessed: {
                  chatKey: submission.chatKey,
                  messageId,
                  bindSession: false,
                },
              },
              onEnqueued: () => {
                terminalErrorCommitted = true;
                const timestamp = nowIso();
                markProcessedChatMessage(
                  runtime.agentDir,
                  submission.chatKey,
                  messageId,
                  { acceptedAt: timestamp, processedAt: timestamp },
                );
              },
            },
          );
        } catch {
          if (
            !terminalErrorCommitted &&
            !hasCommittedTerminalChatOutbox(
              runtime.agentDir,
              submission.chatKey,
              messageId,
            )
          ) {
            return { retry: true, errorMessage };
          }
        }
        await controller.clearProcessingState().catch(() => {});
      }
      return { retry: false, errorMessage };
    };
    try {
      const turnResult = await controller.runTurn({
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
      return {
        retry: false,
        disposition: (turnResult as any)?.superseded
          ? ("superseded" as const)
          : ("actionable" as const),
      };
    } catch (error) {
      return await handleTurnFailure(error);
    }
  };

  let chatBridgeStopping = false;
  const claimedInboxJobs = new Map<string, ClaimedChatInboxJob>();
  const forgetClaimedInboxJob = (job: ClaimedChatInboxJob) => {
    if (claimedInboxJobs.get(job.envelope.itemId) === job) {
      claimedInboxJobs.delete(job.envelope.itemId);
    }
  };
  const releaseClaimedInboxJobForShutdown = (job: ClaimedChatInboxJob) => {
    releaseClaimedChatInboxItem(runtime.agentDir, job.envelope);
    forgetClaimedInboxJob(job);
  };
  const finishClaimedInboxJob = (
    job: ClaimedChatInboxJob,
    result?: ChatInboxJobResult,
  ) => {
    try {
      if (result?.disposition === "superseded") return;
      if (chatBridgeStopping) {
        releaseClaimedInboxJobForShutdown(job);
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
    const heartbeat = setInterval(() => {
      try {
        if (!touchClaimedChatInboxItem(runtime.agentDir, job.envelope)) {
          logger.warn(
            `chat inbox heartbeat lost claim chatKey=${job.envelope.chatKey} turn=${job.envelope.itemId}`,
          );
          const current = getChatInboxItem(
            runtime.agentDir,
            job.envelope.itemId,
          );
          if (current && current.state !== "terminal") {
            const controller = controllers.get(job.envelope.chatKey);
            if (controller?.ownsOutboxTurnFence(fence)) {
              controller.dispose();
              controllers.delete(job.envelope.chatKey);
            }
          }
        }
      } catch (error) {
        logger.warn(
          `chat inbox heartbeat failed chatKey=${job.envelope.chatKey} turn=${job.envelope.itemId} err=${safeString((error as any)?.message || error)}`,
        );
      }
    }, CHAT_INBOX_PROCESSING_HEARTBEAT_MS);
    try {
      const result = await runWithChatOutboxTurnFence(fence, run);
      finishClaimedInboxJob(job, result);
    } catch (error) {
      if (chatBridgeStopping) {
        releaseClaimedInboxJobForShutdown(job);
        return;
      }
      logger.warn(
        `chat inbox worker failed chatKey=${job.envelope.chatKey} turn=${job.envelope.itemId} err=${safeString((error as any)?.message || error)}`,
      );
      requeueClaimedChatInboxJob(
        runtime.agentDir,
        job,
        (error as any)?.message || error,
      );
    } finally {
      clearInterval(heartbeat);
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
          retry: false,
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
    const interruptedUnknownJob = (
      admission: ChatInboxAdmission,
    ): PreparedChatKeyWorkerJob => ({
      run: () =>
        runClaimedInboxJob(job, async () => {
          await enqueueAndDrainOutbox(
            {
              createdAt: nowIso(),
              chatKey: queuedChatKey,
              parts: withChatQuotePart(
                [
                  {
                    type: "text",
                    text: "This turn was interrupted after execution may have started. Rin did not resume it automatically. Send the request again only if you still want it to run.",
                  },
                ],
                envelope.messageId,
              ),
              sessionFile: admission.executionSessionFile,
            },
            "error",
            {
              turnTerminalKind: "interrupted_unknown",
              id: `interrupted-unknown-${buildChatMessageRecordKey(
                queuedChatKey,
                envelope.messageId,
              )}`,
              idempotencyKey: JSON.stringify([
                "interrupted_unknown",
                queuedChatKey,
                envelope.messageId,
              ]),
              postDelivery: {
                markProcessed: {
                  chatKey: queuedChatKey,
                  messageId: envelope.messageId,
                  bindSession: false,
                },
              },
            },
          );
          return {
            retry: false,
            disposition: "actionable",
            terminalKind: "interrupted_unknown",
          };
        }),
    });
    const prepareFromAdmission = (
      admission: ChatInboxAdmission,
    ): PreparedChatKeyWorkerJob => {
      const resolved = resolveDurableChatAdmission(admission, {
        chatKey: envelope.chatKey,
        messageId: envelope.messageId,
      });
      switch (resolved.kind) {
        case "record_only":
          return recordOnlyJob();
        case "command":
          return {
            run: () =>
              runClaimedInboxJob(job, () =>
                handleCommandSession(
                  resolved.command,
                  resolved.promptMeta,
                  resolved.chatKey,
                  resolved.messageId,
                  outboxTurnFenceForClaimedJob(job),
                ),
              ),
          };
        case "unmatched_command":
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
                handlePreparedChatTurnSubmission(resolved.submission),
              ),
          };
        case "interrupted_unknown":
          return interruptedUnknownJob(admission);
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
    // A prior claim may already have caused model, tool, or command side effects.
    // Reclaiming the row must not silently renew that execution authority.
    if (envelope.attemptCount > 1) {
      if (recoveredAdmission.kind === "record_only") return recordOnlyJob();
      return interruptedUnknownJob(envelope.admission);
    }
    if (recoveredAdmission.kind !== "unclassified") {
      return prepareFromAdmission(envelope.admission);
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
    const commandTrust = commandRequest.commandLike
      ? trustOf(
          identity,
          safeString(queuedSession?.platform).trim(),
          pickUserId(queuedSession),
        )
      : "";
    if (
      commandRequest.commandLike &&
      !canRunCommand(commandTrust, commandRequest.name)
    ) {
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

    const decision = await shouldProcessText(
      queuedSession,
      queuedElements,
      identity,
      { chatKey: queuedChatKey },
    );
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
  const chatKeyWorkers = createChatKeyWorkerPool<ClaimedChatInboxJob>({
    prepare: (job) => prepareClaimedInboxJob(job),
    onPrepareError: (job, chatKey, error) => {
      logger.warn(
        `chat inbox prepare failed chatKey=${chatKey} turn=${job.envelope.itemId} err=${safeString((error as any)?.message || error)}`,
      );
      requeueClaimedChatInboxJob(
        runtime.agentDir,
        job,
        (error as any)?.message || error,
      );
      forgetClaimedInboxJob(job);
    },
    onIdle: () => requestDrainChatInbox(),
    logger,
  });

  const inboxDrain = createChatInboxDrain({
    agentDir: runtime.agentDir,
    getController,
    isInboundMessageProcessed,
    enqueueClaimedInboxItem: (job) => {
      claimedInboxJobs.set(job.envelope.itemId, job);
      if (chatBridgeStopping) {
        releaseClaimedInboxJobForShutdown(job);
        return;
      }
      chatKeyWorkers.enqueue(job.envelope.chatKey, job);
    },
    isChatKeyBlocked: (chatKey) => app.isInboundRecoveryChat(chatKey),
    hasActiveChatKeyWorker: (chatKey) => chatKeyWorkers.hasWorker(chatKey),
    isPriorityDuringActiveChatKeyWorker: (envelope) => {
      const frozenCommand =
        envelope.admission.state === "actionable" &&
        envelope.admission.decision?.kind === "command"
          ? (envelope.admission.decision.command as any)
          : undefined;
      if (frozenCommand) {
        return ["abort", "new"].includes(safeString(frozenCommand.name).trim());
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
      return ["abort", "new"].includes(commandRequest.command?.name || "");
    },
    canClaimDuringActiveChatKeyWorker: async (envelope) => {
      if (envelope.admission.state === "actionable") return true;
      if (envelope.admission.state === "record_only") return false;
      const queuedSession = restoreChatInboxSession(
        envelope,
        findRuntimeBot(
          safeString(envelope?.session?.platform || "").trim(),
          safeString(envelope?.session?.selfId || "").trim(),
        ),
      );
      const queuedElements = restoreChatInboxElements(envelope);
      const queuedChatKey =
        safeString(envelope.chatKey).trim() || sessionChatKey(queuedSession);
      if (isRecordOnlyChatKey(queuedChatKey)) return false;
      const identity = getIdentity();
      const commandRequest = parseInboundCommandRequest(
        queuedSession,
        elementsToCommandText(queuedElements),
        commandRows,
      );
      if (commandRequest.command || commandRequest.commandLike) return true;
      const decision = await shouldProcessText(
        queuedSession,
        queuedElements,
        identity,
        { chatKey: queuedChatKey },
      );
      if (!decision.allow) return false;
      return !isRecordOnlyChatKey(decision.chatKey);
    },
    logger,
  });

  requestDrainChatInbox = () => {
    if (chatBridgeStopping) return;
    inboxDrain.requestDrainChatInbox();
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
          "chat inbound accepted while bridge stopping; leaving pending for recovery",
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
  const send = async (payload: ChatOutboxPayloadInput) => {
    const result = await enqueueAndDrainOutbox(payload, "generic");
    return result.status === "delivered"
      ? { delivered: true as const }
      : {
          delivered: false as const,
          pending: true as const,
          outboxId: result.id,
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
  const runTurn = async (payload: ChatBridgeTurnPayload) => {
    const chatKey = safeString(payload?.chatKey).trim();
    const text = safeString(payload?.text).trim();
    const { sessionFile } = normalizeSessionRef(payload);
    const controllerKey =
      safeString(payload?.controllerKey).trim() || "default";
    const affectChatBinding = payload?.affectChatBinding !== false;
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
  const setWorkingVisible = async (payload: {
    chatKey?: string;
    controllerKey?: string;
    visible?: boolean;
  }) => {
    const chatKey = safeString(payload?.chatKey).trim();
    const controllerKey =
      safeString(payload?.controllerKey).trim() || (chatKey ? "default" : "");
    if (!chatKey && !controllerKey) return { handled: false };
    const useBoundController = Boolean(chatKey && controllerKey === "default");
    const controller = useBoundController
      ? getController(chatKey)
      : getDetachedController(controllerKey, {
          chatKey,
          affectChatBinding: false,
        });
    if (payload?.visible === false) {
      await controller.endExternalWorking().catch(() => {});
      return { handled: true };
    }
    await controller.beginExternalWorking().catch(() => {});
    return { handled: true };
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

  await app.start();
  await syncTelegramCommands(app, logger, commandRows);
  await syncDiscordCommands(app, logger, commandRows);
  logger.info(
    `chat bridge started bots=${JSON.stringify(app.bots.map((bot: any) => ({ platform: bot.platform, selfId: bot.selfId, status: bot.status })))}`,
  );

  reconcileCommittedChatOutboxProcessing(runtime.agentDir);
  const restoredProcessing = restoreProcessingChatInboxItems(runtime.agentDir);
  if (restoredProcessing.length) {
    logger.warn(
      `chat inbox recovery restored processing=${restoredProcessing.length}`,
    );
  }

  requestDrainChatInbox();
  inboxPollTimer = setInterval(() => {
    try {
      restoreProcessingChatInboxItems(runtime.agentDir);
    } catch (error) {
      logger.warn(
        `chat inbox lease recovery failed err=${safeString((error as any)?.message || error)}`,
      );
    }
    requestDrainChatInbox();
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
      clearInterval(typingPollTimer);
      if (inboxPollTimer) clearInterval(inboxPollTimer);
      if (outboxPollTimer) clearInterval(outboxPollTimer);
      if (outboxHistoryCleanupTimer) clearInterval(outboxHistoryCleanupTimer);
      for (const job of [...claimedInboxJobs.values()]) {
        releaseClaimedInboxJobForShutdown(job);
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
    const adapters = app.getAdapterStatuses();
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

  if (!options.hosted) {
    const handleSignal = (code = 0) => {
      void stop().finally(() => {
        process.exit(code);
      });
    };
    process.on("SIGINT", () => handleSignal(0));
    process.on("SIGTERM", () => handleSignal(0));
  }

  return {
    app,
    options,
    stop,
    getStatus,
    send,
    typing,
    react,
    runTurn,
    setWorkingVisible,
    terminateTurn,
    evalBridge,
  };
}

async function main() {
  await startChatBridge();
}

const isDirectEntry =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectEntry) {
  main().catch((error: any) => {
    logger.error(String(error?.message || error || "rin_chat_failed"));
    process.exit(1);
  });
}
