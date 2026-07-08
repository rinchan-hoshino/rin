#!/usr/bin/env node
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
  persistInboundMessage,
  pickChatName,
  pickMessageId,
  pickReplyToMessageId,
  pickSenderNickname,
  pickUnsessionedOwnQuoteText,
  pickUserId,
  prependQuoteTextToPromptBody,
  renderPromptTextWithSavedAttachments,
  safeString,
  hasInboundChatMessageReplyBoundary,
  isInboundChatMessageProcessed,
  isReplyToLatestAssistantMessage,
} from "./chat-helpers.js";
import { buildInboundChatLogInput } from "./inbound-normalization.js";
import { ChatController, loadChatSettings } from "./controller.js";
import { readChatCommandResponses } from "./command-responses.js";
import {
  resolveChatModelOptions,
  resolveChatTurnPolicyMode,
} from "./settings.js";
import { appendChatLog } from "./chat-log.js";
import {
  type ChatInboxItem,
  reconcileChatInboxRecovery,
  restoreChatInboxSession,
  touchChatInboxFile,
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
import type { RinToolStartupOptions } from "../rin-lib/tool-options.js";
import type { RinPiPassthroughOptions } from "../rin-lib/pi-passthrough.js";
import {
  cleanupChatOutboxHistory,
  enqueueChatOutboxPayload,
  type ChatOutboxPayloadInput,
} from "../rin-lib/chat-outbox.js";
import { sendReaction, sendTyping } from "./transport.js";
import { readConfiguredLanguageFromSettings } from "../language.js";
import { normalizeSessionRef } from "../session/ref.js";
import { formatRuntimeErrorForChat } from "../rin-lib/user-facing-errors.js";

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
const CHAT_STEERED_INBOX_WAIT_INTERVAL_MS = 1000;
const CHAT_STEERED_INBOX_INACTIVE_GRACE_MS = 5000;
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
    model?: string;
    thinkingLevel?: string;
    promptMeta?: PromptContextMeta;
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
  startedAt: string;
  settingsPath: string;
  adapterCount: number;
  botCount: number;
  controllerCount: number;
  detachedControllerCount: number;
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
  send: (payload: ChatOutboxPayloadInput) => Promise<{ delivered: true }>;
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
  const enqueueAndDrainOutbox = async (
    payload: ChatOutboxPayloadInput,
    deliveryKind: "command_ack" | "error" | "generic" = "generic",
  ) => {
    const id = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`;
    enqueueChatOutboxPayload(runtime.agentDir, payload, { id, deliveryKind });
    const results = await drainChatOutbox(app, runtime.agentDir, h, logger, {
      chatKey: safeString(payload.chatKey).trim(),
      itemId: id,
    });
    const own = Array.isArray(results)
      ? results.find((item: any) => item?.id === id)
      : null;
    if (!own) {
      throw new Error("chat_outbox_delivery_missing");
    }
    if (own.status !== "delivered") {
      if (own.status === "dispatched") return;
      throw new Error(
        safeString((own as any).error).trim() || "chat_outbox_delivery_pending",
      );
    }
  };
  const chatRuntimeRoot = path.join(dataDir, "chat-runtime");
  try {
    ensureChatRuntimeDependencies(chatRuntimeRoot, settings);
  } catch (error: any) {
    logger.warn(
      `chat runtime dependency install failed err=${String(error?.message || error)}`,
    );
  }
  const builtInRuntimeAdapters = await instantiateChatRuntimeAdapters(app, {
    dataDir,
    adapterEntries: listChatRuntimeAdapterEntries(settings),
    logger,
  });
  const externalRuntimeAdapters = await instantiateExternalChatRuntimeAdapters(
    app,
    {
      agentDir: runtime.agentDir,
      dataDir,
      runtimeRoot: chatRuntimeRoot,
      h,
      adapterEntries: options.chatAdapterProviders || [],
      logger,
    },
  );
  const runtimeAdapters = [
    ...builtInRuntimeAdapters,
    ...externalRuntimeAdapters,
  ];
  const controllers = new Map<string, ChatController>();
  const detachedControllers = new Map<string, ChatController>();
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
  const chatLanguageTag = readConfiguredLanguageFromSettings(runtime.agentDir);
  const commandRows = getChatCommandRows(chatLanguageTag);
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
    const statePath = path.join(
      dataDir,
      "scheduler",
      "turns",
      safeString(controllerKey)
        .trim()
        .replace(/[^A-Za-z0-9._:-]+/g, "_"),
      "state.json",
    );
    const controllerChatKey =
      safeString(detachedOptions?.chatKey).trim() || `cron:${controllerKey}`;
    let controller = detachedControllers.get(controllerKey);
    if (!controller) {
      controller = new ChatController(app, dataDir, controllerChatKey, {
        logger,
        h,
        affectChatBinding: detachedOptions?.affectChatBinding,
        statePath,
        frontendClientFactory,
        sleepAfterIdleMs: DETACHED_CONTROLLER_SLEEP_IDLE_MS,
        commandResponses: chatCommandResponses,
        frontendIdentity: detachedOptions?.frontendIdentity,
        useChatFrontendIdentity: Boolean(detachedOptions?.chatKey),
      });
      detachedControllers.set(controllerKey, controller);
      return controller;
    }
    if (controller.chatKey !== controllerChatKey) {
      controller.chatKey = controllerChatKey;
      controller.state.chatKey = controllerChatKey;
      controller.dispose();
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
    session: any,
    identity: any,
    commandName: string,
  ) => {
    const platform = safeString(session?.platform || "").trim();
    const trust = trustOf(identity, platform, pickUserId(session));
    if (!canRunCommand(trust, commandName)) {
      return { retry: false };
    }
    if (!(await isEffectivePrivateChatSession(session, identity))) {
      return { retry: false };
    }
    const chatKey = sessionChatKey(session);
    const messageId = pickMessageId(session);
    if (!chatKey) return { retry: false };
    await enqueueAndDrainOutbox(
      {
        createdAt: nowIso(),
        chatKey,
        replyToMessageId: messageId || undefined,
        parts: [
          {
            type: "text",
            text: "Unknown command. Send /help to see available commands.",
          },
        ],
      },
      "error",
    ).catch(() => {});
    return { retry: false };
  };

  const handleCommandSession = async (
    session: any,
    command: { name: string; argsText: string },
    identity: any,
  ) => {
    const platform = safeString(session?.platform || "").trim();
    const trust = trustOf(identity, platform, pickUserId(session));
    const chatKey = sessionChatKey(session);
    const messageId = pickMessageId(session);
    if (!chatKey) return { retry: false };
    const promptMeta = {
      source: "chat-bridge",
      selfImproveEligible: true,
      sentAt: Number.isFinite(Number(session?.timestamp))
        ? Number(session.timestamp)
        : Date.now(),
      chatKey,
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
    };

    if (!canRunCommand(trust, command.name)) {
      return { retry: false };
    }

    if (command.name === "help") {
      const lines = commandRows.map(
        (entry) =>
          `/${entry.name}${entry.description ? ` — ${entry.description}` : ""}`,
      );
      await enqueueAndDrainOutbox(
        {
          createdAt: nowIso(),
          chatKey,
          replyToMessageId: messageId || undefined,
          parts: [{ type: "text", text: lines.join("\n") }],
        },
        "command_ack",
      ).catch(() => {});
      return { retry: false };
    }

    const controller = getController(chatKey);

    const text = `/${command.name}${command.argsText ? ` ${command.argsText}` : ""}`;
    try {
      await controller.runCommand(text, messageId, messageId, "", promptMeta);
      return { retry: false };
    } catch (error) {
      logger.warn(
        `chat command failed chatKey=${chatKey} command=${command.name} err=${safeString((error as any)?.message || error)}`,
      );
      return {
        retry: false,
        errorMessage: safeString((error as any)?.message || error),
      };
    }
  };

  const handleAllowedChatTurnSession = async (
    session: any,
    elements: any[],
    identity: any,
    decision: Awaited<ReturnType<typeof shouldProcessText>>,
  ) => {
    const messageId = pickMessageId(session);
    const replyToMessageId = pickReplyToMessageId(session);
    const controller = getController(decision.chatKey);
    const replySession = lookupReplySession(
      runtime.agentDir,
      decision.chatKey,
      replyToMessageId,
    );
    const linkedSessionFile = safeString(
      replySession?.sessionFile || "",
    ).trim();
    const quotedOwnMessageText = pickUnsessionedOwnQuoteText({
      session,
      linked: replySession?.linked,
      linkedSessionFile,
    });
    const shouldOmitPromptReplyTo =
      Boolean(quotedOwnMessageText) ||
      isReplyToLatestAssistantMessage(
        runtime.agentDir,
        decision.chatKey,
        replyToMessageId,
      );
    const promptReplyToMessageId = shouldOmitPromptReplyTo
      ? ""
      : replyToMessageId;
    const { attachments, failures } = await extractInboundAttachments(
      elements,
      chatStateDir(dataDir, decision.chatKey),
    );
    if (failures.length) {
      let telegramDebug = "";
      if (safeString(session?.platform || "").trim() === "telegram") {
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
    const promptRichText = attachments.length
      ? renderPromptTextWithSavedAttachments(elements, attachments)
      : "";
    const turnText = prependQuoteTextToPromptBody(
      promptRichText || decision.text,
      quotedOwnMessageText,
    );
    const promptBody = inboundAttachmentNotice
      ? `${turnText}\n\n${inboundAttachmentNotice}`
      : turnText;
    const promptMeta = {
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
        safeString(session?.platform || "").trim(),
        pickUserId(session),
      ),
      runtimeMetadata:
        session?.runtimeMetadata && typeof session.runtimeMetadata === "object"
          ? session.runtimeMetadata
          : undefined,
      requiresMentionToStartTurn:
        decision.requiresMentionToStartTurn || undefined,
      replyToMessageId: promptReplyToMessageId || undefined,
      attachedFiles: attachments
        .filter((item) => item?.kind === "file")
        .map((item) => ({ name: item.name, path: item.path })),
    };
    const handleTurnFailure = async (error: any) => {
      const errorMessage = safeString((error as any)?.message || error);
      logger.warn(
        `chat turn failed chatKey=${decision.chatKey} err=${errorMessage}`,
      );
      if (
        errorMessage &&
        messageId &&
        !isInboundChatMessageProcessed(
          runtime.agentDir,
          decision.chatKey,
          messageId,
        )
      ) {
        void enqueueAndDrainOutbox(
          {
            createdAt: nowIso(),
            chatKey: decision.chatKey,
            replyToMessageId: messageId || undefined,
            parts: [
              { type: "text", text: formatRuntimeErrorForChat(errorMessage) },
            ],
            sessionFile: linkedSessionFile || undefined,
          },
          "error",
        ).catch(() => {});
        void controller.clearProcessingState().catch(() => {});
      }
      return {
        retry: false,
        errorMessage,
      };
    };
    try {
      await controller.runTurn({
        text: promptBody,
        attachments,
        promptMeta,
        replyToMessageId: messageId,
        incomingMessageId: messageId,
        sessionFile: linkedSessionFile || undefined,
        ...resolveChatModelOptions(settings, decision.chatKey),
      });
      return { retry: false };
    } catch (error) {
      return await handleTurnFailure(error);
    }
  };

  const handleChatTurnSession = async (
    session: any,
    elements: any[],
    identity: any,
  ) => {
    const decision = await shouldProcessText(session, elements, identity, {
      chatKey: sessionChatKey(session),
    });
    if (!decision.allow) return { retry: false };
    if (isRecordOnlyChatKey(decision.chatKey)) {
      return { retry: false };
    }
    return await handleAllowedChatTurnSession(
      session,
      elements,
      identity,
      decision,
    );
  };

  const waitForSteeredInboxCompletion = async (
    job: ClaimedChatInboxJob,
    result: (ChatInboxJobResult & { steered?: boolean }) | undefined,
  ): Promise<ChatInboxJobResult | undefined> => {
    if (!result?.steered) return result;
    const chatKey = safeString(job.envelope.chatKey).trim();
    const messageId = safeString(job.envelope.messageId).trim();
    if (!chatKey || !messageId) return result;
    const controller = getController(chatKey);
    let inactiveSince = 0;
    for (;;) {
      if (isInboundMessageProcessed(chatKey, messageId)) return result;
      const stillOwned = Boolean(
        controller.ownsInboundMessage(messageId) || controller.hasActiveTurn(),
      );
      if (stillOwned) {
        inactiveSince = 0;
      } else {
        inactiveSince ||= Date.now();
        if (
          Date.now() - inactiveSince >=
          CHAT_STEERED_INBOX_INACTIVE_GRACE_MS
        ) {
          return {
            retry: false,
            errorMessage: "chat_steered_turn_unprocessed",
          };
        }
      }
      await new Promise((resolve) =>
        setTimeout(resolve, CHAT_STEERED_INBOX_WAIT_INTERVAL_MS),
      );
    }
  };

  const runClaimedInboxJob = async (
    job: ClaimedChatInboxJob,
    run: () => Promise<ChatInboxJobResult | undefined>,
  ) => {
    const heartbeat = setInterval(() => {
      try {
        touchChatInboxFile(job.claimedPath, job.envelope);
      } catch (error) {
        logger.warn(
          `chat inbox heartbeat failed chatKey=${job.envelope.chatKey} file=${job.claimedPath} err=${safeString((error as any)?.message || error)}`,
        );
      }
    }, CHAT_INBOX_PROCESSING_HEARTBEAT_MS);
    try {
      const result = await waitForSteeredInboxCompletion(job, await run());
      finalizeClaimedChatInboxJob(runtime.agentDir, job, result);
    } catch (error) {
      logger.warn(
        `chat inbox worker failed chatKey=${job.envelope.chatKey} file=${job.claimedPath} err=${safeString((error as any)?.message || error)}`,
      );
      requeueClaimedChatInboxJob(
        runtime.agentDir,
        job,
        (error as any)?.message || error,
      );
    } finally {
      clearInterval(heartbeat);
    }
  };

  const prepareClaimedInboxJob = async (
    job: ClaimedChatInboxJob,
  ): Promise<PreparedChatKeyWorkerJob> => {
    const { envelope } = job;
    const queuedSession = restoreChatInboxSession(
      envelope,
      findRuntimeBot(
        safeString(envelope?.session?.platform || "").trim(),
        safeString(envelope?.session?.selfId || "").trim(),
      ),
    );
    const queuedElements = Array.isArray(envelope.elements)
      ? envelope.elements
      : [];
    const queuedChatKey =
      safeString(envelope.chatKey).trim() || sessionChatKey(queuedSession);
    if (isRecordOnlyChatKey(queuedChatKey)) {
      return {
        run: () => runClaimedInboxJob(job, async () => ({ retry: false })),
      };
    }
    const identity = getIdentity();
    const commandRequest = parseInboundCommandRequest(
      queuedSession,
      elementsToText(queuedElements),
      commandRows,
    );
    if (commandRequest.command) {
      return {
        run: () =>
          runClaimedInboxJob(job, () =>
            handleCommandSession(
              queuedSession,
              commandRequest.command!,
              identity,
            ),
          ),
      };
    }
    if (commandRequest.commandLike) {
      return {
        run: () =>
          runClaimedInboxJob(job, () =>
            handleUnmatchedCommandSession(
              queuedSession,
              identity,
              commandRequest.name,
            ),
          ),
      };
    }

    const decision = await shouldProcessText(
      queuedSession,
      queuedElements,
      identity,
      { chatKey: queuedChatKey },
    );
    if (!decision.allow) {
      return {
        run: () => runClaimedInboxJob(job, async () => ({ retry: false })),
      };
    }
    if (isRecordOnlyChatKey(decision.chatKey)) {
      return {
        run: () => runClaimedInboxJob(job, async () => ({ retry: false })),
      };
    }

    return {
      run: () =>
        runClaimedInboxJob(job, () =>
          handleAllowedChatTurnSession(
            queuedSession,
            queuedElements,
            identity,
            decision,
          ),
        ),
    };
  };

  const chatKeyWorkers = createChatKeyWorkerPool<ClaimedChatInboxJob>({
    prepare: (job) => prepareClaimedInboxJob(job),
    onPrepareError: (job, chatKey, error) => {
      logger.warn(
        `chat inbox prepare failed chatKey=${chatKey} file=${job.claimedPath} err=${safeString((error as any)?.message || error)}`,
      );
      requeueClaimedChatInboxJob(
        runtime.agentDir,
        job,
        (error as any)?.message || error,
      );
    },
    logger,
  });

  const { requestDrainChatInbox } = createChatInboxDrain({
    agentDir: runtime.agentDir,
    getController,
    isInboundMessageProcessed,
    enqueueClaimedInboxItem: (job) =>
      chatKeyWorkers.enqueue(job.envelope.chatKey, job),
    hasActiveChatKeyWorker: (chatKey) => chatKeyWorkers.hasWorker(chatKey),
    canClaimDuringActiveChatKeyWorker: async (envelope) => {
      const queuedSession = restoreChatInboxSession(
        envelope,
        findRuntimeBot(
          safeString(envelope?.session?.platform || "").trim(),
          safeString(envelope?.session?.selfId || "").trim(),
        ),
      );
      const queuedElements = Array.isArray(envelope.elements)
        ? envelope.elements
        : [];
      const queuedChatKey =
        safeString(envelope.chatKey).trim() || sessionChatKey(queuedSession);
      if (isRecordOnlyChatKey(queuedChatKey)) return false;
      const identity = getIdentity();
      const commandRequest = parseInboundCommandRequest(
        queuedSession,
        elementsToText(queuedElements),
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

  app.on("message", (session: any) => {
    void (async () => {
      const identity = getIdentity();
      const elements = ensureSessionElements(session);
      try {
        const chatKey = sessionChatKey(session);
        persistInboundMessage(
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

      requestDrainChatInbox();
    })().catch((error: any) => {
      logger.warn(
        `chat inbound handling failed err=${safeString(error?.message || error)}`,
      );
    });
  });

  inboxPollTimer = setInterval(() => {
    requestDrainChatInbox();
  }, CHAT_INBOX_POLL_INTERVAL_MS);

  app.on("bot-status-updated", (bot: any) => {
    if (bot?.status !== 1) return;
    void syncTelegramCommands(app, logger, commandRows);
    void syncDiscordCommands(app, logger, commandRows);
  });

  const startedAt = nowIso();
  const send = async (payload: ChatOutboxPayloadInput) => {
    await enqueueAndDrainOutbox(payload, "generic");
    return { delivered: true as const };
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
        deliverFinal: payload?.deliverFinal,
        quietMode: payload?.quietMode,
      });
    } finally {
      if (!useBoundController && (disposeAfterTurn || shutdownAfterTurn)) {
        if (shutdownAfterTurn) {
          await controller.terminateSession().catch((error: any) => {
            logger.warn(
              `chat detached turn shutdown failed controllerKey=${controllerKey} err=${safeString(error?.message || error)}`,
            );
          });
        } else {
          controller.dispose();
        }
        detachedControllers.delete(controllerKey);
        try {
          fs.rmSync(
            path.join(
              dataDir,
              "scheduler",
              "turns",
              controllerKey.replace(/[^A-Za-z0-9._:-]+/g, "_"),
            ),
            {
              recursive: true,
              force: true,
            },
          );
        } catch {}
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

  const inboxRecovery = reconcileChatInboxRecovery(runtime.agentDir);
  if (
    inboxRecovery.restoredProcessing.length ||
    inboxRecovery.restoredOrphans.length
  ) {
    logger.warn(
      `chat inbox recovery restored processing=${inboxRecovery.restoredProcessing.length} orphanedAccepted=${inboxRecovery.restoredOrphans.length}`,
    );
  }

  requestDrainChatInbox();
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
      clearInterval(typingPollTimer);
      if (inboxPollTimer) clearInterval(inboxPollTimer);
      if (outboxPollTimer) clearInterval(outboxPollTimer);
      if (outboxHistoryCleanupTimer) clearInterval(outboxHistoryCleanupTimer);
      for (const controller of controllers.values()) {
        if (options.hosted === true) {
          await controller.shutdownSession().catch(() => {});
        } else {
          controller.dispose();
        }
      }
      for (const controller of detachedControllers.values()) {
        if (options.hosted === true) {
          await controller.shutdownSession().catch(() => {});
        } else {
          controller.dispose();
        }
      }
      try {
        await app.stop();
      } catch {}
    })();
    return await stoppingPromise;
  };
  const getStatus = (): ChatBridgeStatus => ({
    ready: true,
    startedAt,
    settingsPath,
    adapterCount: runtimeAdapters.length,
    botCount: Array.isArray(app.bots) ? app.bots.length : 0,
    controllerCount: controllers.size,
    detachedControllerCount: detachedControllers.size,
  });

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
