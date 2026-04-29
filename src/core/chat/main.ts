#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  applyRuntimeProfileEnvironment,
  resolveRuntimeProfile,
} from "../rin-lib/runtime.js";
import type { RpcFrontendClient } from "../rin-tui/frontend-surface.js";
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
import { getChatCommandRows, syncTelegramCommands } from "./boot.js";
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
  pickUserId,
  safeString,
  hasInboundChatMessageReplyBoundary,
} from "./chat-helpers.js";
import { buildInboundChatLogInput } from "./inbound-normalization.js";
import { ChatController, loadChatSettings } from "./controller.js";
import { appendChatLog } from "./chat-log.js";
import {
  claimChatInboxFile,
  completeChatInboxFile,
  listPendingChatInboxFiles,
  readChatInboxItem,
  requeueChatInboxFile,
  restoreChatInboxFile,
  restoreChatInboxSession,
  restoreProcessingChatInboxFiles,
} from "./inbox.js";
import { shouldProcessText } from "./decision.js";
import {
  createChatRuntimeApp,
  createChatRuntimeH,
  instantiateBuiltInChatRuntimeAdapters,
} from "../chat-runtime/index.js";
import { listChatRuntimeAdapterEntries } from "./runtime-config.js";
import { composeChatKey, loadIdentity, trustOf } from "./support.js";
import { sendOutboxPayload } from "./transport.js";
import type { ChatOutboxPayload } from "../rin-lib/chat-outbox.js";
import { normalizeSessionRef } from "../session/ref.js";
import { isTransientChatRuntimeError } from "./runtime-errors.js";

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
const RIN_CHAT_SETTINGS_PATH_ENV = "RIN_CHAT_SETTINGS_PATH";
const LEGACY_RIN_KOISHI_SETTINGS_PATH_ENV = "RIN_KOISHI_SETTINGS_PATH";
const TYPING_POLL_INTERVAL_MS = 4000;
const CHAT_INBOX_POLL_INTERVAL_MS = 3000;
const CHAT_INBOX_RETRY_MIN_MS = 2000;
const CHAT_INBOX_RETRY_MAX_MS = 60_000;

function computeChatInboxRetryDelay(attemptCount: number) {
  const attempt = Math.max(0, Number(attemptCount || 0));
  return Math.min(
    CHAT_INBOX_RETRY_MAX_MS,
    CHAT_INBOX_RETRY_MIN_MS * 2 ** attempt,
  );
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

function parseInboundCommand(
  session: any,
  text: string,
  commandRows: Array<{ name: string }>,
) {
  const input = safeString(text).trim();
  if (!input.startsWith("/")) return null;
  const spaceIndex = input.indexOf(" ");
  const head = (spaceIndex >= 0 ? input.slice(0, spaceIndex) : input)
    .slice(1)
    .trim();
  if (!head) return null;
  const argsText = spaceIndex >= 0 ? input.slice(spaceIndex + 1).trim() : "";
  const [rawName, rawTarget = ""] = head.split("@", 2);
  const name = safeString(rawName).trim().toLowerCase();
  if (!name) return null;
  const active = commandRows.some(
    (item) => safeString(item?.name).trim() === name,
  );
  if (!active) return null;
  const target = safeString(rawTarget).trim().replace(/^@+/, "").toLowerCase();
  if (target) {
    const targets = getCommandTargets(session);
    if (targets.size && !targets.has(target)) return null;
  }
  return { name, argsText };
}

export type ChatBridgeTurnPayload = {
  chatKey?: string;
  controllerKey?: string;
  deliveryEnabled?: boolean;
  affectChatBinding?: boolean;
  disposeAfterTurn?: boolean;
  text: string;
  sessionFile?: string;
  managedSessionLeaf?: string;
  model?: string;
  thinkingLevel?: string;
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
    frontendClientFactory?: () => RpcFrontendClient;
  };
  stop: () => Promise<void>;
  getStatus: () => ChatBridgeStatus;
  send: (payload: ChatOutboxPayload) => Promise<{ delivered: true }>;
  runTurn: (payload: ChatBridgeTurnPayload) => Promise<any>;
  evalBridge: (payload: ChatBridgeEvalPayload) => Promise<any>;
};

export async function startChatBridge(
  options: {
    additionalExtensionPaths?: string[];
    hosted?: boolean;
    frontendClientFactory?: () => RpcFrontendClient;
  } = {},
): Promise<ChatBridgeHandle> {
  const runtime = resolveRuntimeProfile();
  const dataDir = path.join(runtime.agentDir, "data");
  const settingsPath =
    process.env[RIN_CHAT_SETTINGS_PATH_ENV]?.trim() ||
    process.env[LEGACY_RIN_KOISHI_SETTINGS_PATH_ENV]?.trim() ||
    path.join(runtime.agentDir, "settings.json");
  applyRuntimeProfileEnvironment(runtime);
  if (process.cwd() !== runtime.cwd) process.chdir(runtime.cwd);
  ensureDir(dataDir);

  const settings = loadChatSettings(settingsPath);

  const h = createChatRuntimeH();
  const app = createChatRuntimeApp(runtime.agentDir);
  const runtimeAdapters = instantiateBuiltInChatRuntimeAdapters(app, {
    dataDir,
    settings,
    adapterEntries: listChatRuntimeAdapterEntries(settings),
    logger,
  });
  if (!runtimeAdapters.length) {
    logger.warn("no runtime chat adapters configured");
  }
  const controllers = new Map<string, ChatController>();
  const detachedControllers = new Map<string, ChatController>();
  let inboxPollTimer: NodeJS.Timeout | null = null;
  const typingPollTimer = setInterval(() => {
    for (const controller of controllers.values()) {
      void controller.pollTyping().catch(() => {});
    }
    for (const controller of detachedControllers.values()) {
      void controller.pollTyping().catch(() => {});
    }
  }, TYPING_POLL_INTERVAL_MS);
  const commandRows = getChatCommandRows();
  const frontendClientFactory = options.frontendClientFactory;
  const getIdentity = () => loadIdentity(dataDir);
  const getController = (chatKey: string) => {
    let controller = controllers.get(chatKey);
    if (!controller) {
      controller = new ChatController(app, dataDir, chatKey, {
        logger,
        h,
        frontendClientFactory,
      });
      controllers.set(chatKey, controller);
    }
    return controller;
  };
  const getDetachedController = (
    controllerKey: string,
    detachedOptions?: {
      chatKey?: string;
      deliveryEnabled?: boolean;
      affectChatBinding?: boolean;
    },
  ) => {
    const statePath = path.join(
      dataDir,
      "cron-turns",
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
        deliveryEnabled: detachedOptions?.deliveryEnabled,
        affectChatBinding: detachedOptions?.affectChatBinding,
        statePath,
        frontendClientFactory,
      });
      detachedControllers.set(controllerKey, controller);
      return controller;
    }
    if (controller.chatKey !== controllerChatKey) {
      controller.chatKey = controllerChatKey;
      controller.state.chatKey = controllerChatKey;
      void controller.session?.reload?.().catch(() => {});
    }
    return controller;
  };
  const findRuntimeBot = (platform: string, selfId: string) =>
    (Array.isArray(app.bots) ? app.bots : []).find(
      (bot: any) =>
        safeString(bot?.platform).trim() === safeString(platform).trim() &&
        safeString(bot?.selfId).trim() === safeString(selfId).trim(),
    );
  const isInboundMessageProcessed = (chatKey: string, messageId: string) =>
    hasInboundChatMessageReplyBoundary(runtime.agentDir, chatKey, messageId);
  const handleCommandSession = async (
    session: any,
    command: { name: string; argsText: string },
    identity: any,
  ) => {
    const platform = safeString(session?.platform || "").trim();
    const trust = trustOf(identity, platform, pickUserId(session));
    const chatKey = composeChatKey(
      platform,
      getChatId(session),
      safeString(session?.selfId || session?.bot?.selfId || "").trim(),
    );
    const messageId = pickMessageId(session);
    const replyToMessageId = pickReplyToMessageId(session);
    if (!chatKey) return { retry: false };
    const replySession = lookupReplySession(
      runtime.agentDir,
      chatKey,
      replyToMessageId,
    );

    if (command.name !== "help" && !canRunCommand(trust, command.name)) {
      return { retry: false };
    }

    if (command.name === "help") {
      const lines = commandRows.map(
        (entry) =>
          `/${entry.name}${entry.description ? ` — ${entry.description}` : ""}`,
      );
      await sendOutboxPayload(
        app,
        runtime.agentDir,
        {
          type: "text_delivery",
          createdAt: new Date().toISOString(),
          chatKey,
          text: lines.join("\n"),
          replyToMessageId: messageId || undefined,
          sessionFile: replySession?.sessionFile,
        },
        h,
      ).catch(() => {});
      return { retry: false };
    }

    const controller = getController(chatKey);

    const text = `/${command.name}${command.argsText ? ` ${command.argsText}` : ""}`;
    try {
      await controller.runCommand(
        text,
        messageId,
        messageId,
        replySession?.sessionFile || "",
      );
      return { retry: false };
    } catch (error) {
      logger.warn(
        `chat command failed chatKey=${chatKey} command=${command.name} err=${safeString((error as any)?.message || error)}`,
      );
      return {
        retry: isTransientChatRuntimeError(error),
        errorMessage: safeString((error as any)?.message || error),
      };
    }
  };

  const handleChatTurnSession = async (
    session: any,
    elements: any[],
    identity: any,
  ) => {
    const decision = await shouldProcessText(session, elements, identity);
    if (!decision.allow) return { retry: false };
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
    const promptBody = inboundAttachmentNotice
      ? `${decision.text}\n\n${inboundAttachmentNotice}`
      : decision.text;
    const promptMeta = {
      source: "chat-bridge",
      sentAt: Number.isFinite(Number(session?.timestamp))
        ? Number(session.timestamp)
        : Date.now(),
      chatKey: decision.chatKey,
      chatName:
        pickChatName(session) ||
        (getChatType(session) === "private" ? pickSenderNickname(session) : ""),
      chatType: getChatType(session),
      userId: pickUserId(session),
      nickname: pickSenderNickname(session),
      identity: trustOf(
        identity,
        safeString(session?.platform || "").trim(),
        pickUserId(session),
      ),
      replyToMessageId: replyToMessageId || undefined,
      attachedFiles: attachments
        .filter((item) => item?.kind === "file")
        .map((item) => ({ name: item.name, path: item.path })),
    };
    const handleTurnFailure = async (
      error: any,
      sessionFile = linkedSessionFile,
    ) => {
      const errorMessage = safeString((error as any)?.message || error);
      const transientFailure = isTransientChatRuntimeError(errorMessage);
      logger.warn(
        `chat turn failed chatKey=${decision.chatKey} transient=${transientFailure} err=${errorMessage}`,
      );
      if (!transientFailure) {
        void sendOutboxPayload(
          app,
          runtime.agentDir,
          {
            type: "text_delivery",
            createdAt: new Date().toISOString(),
            chatKey: decision.chatKey,
            text: errorMessage || "chat_bridge_turn_failed",
            replyToMessageId: messageId || undefined,
            sessionFile: sessionFile || undefined,
          },
          h,
        ).catch(() => {});
        void controller.clearProcessingState().catch(() => {});
      }
      return { retry: transientFailure, errorMessage };
    };
    try {
      await controller.runTurn(
        {
          text: promptBody,
          attachments,
          promptMeta,
          replyToMessageId: messageId,
          incomingMessageId: messageId,
          sessionFile: linkedSessionFile || undefined,
        },
        controller.canSteerActiveTurn() ? "steer" : "prompt",
      );
      return { retry: false };
    } catch (error) {
      return await handleTurnFailure(error, linkedSessionFile);
    }
  };

  const activeInboxRuns = new Map<string, Promise<void>>();
  const dispatchClaimedInboxItem = (claimedPath: string, envelope: any) => {
    if (!claimedPath || activeInboxRuns.has(claimedPath)) return;
    const run = (async () => {
      try {
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
        const identity = getIdentity();
        const command = parseInboundCommand(
          queuedSession,
          elementsToText(queuedElements),
          commandRows,
        );
        const result = command
          ? await handleCommandSession(queuedSession, command, identity)
          : await handleChatTurnSession(
              queuedSession,
              queuedElements,
              identity,
            );
        if (result?.retry) {
          requeueChatInboxFile(runtime.agentDir, claimedPath, envelope, {
            delayMs: computeChatInboxRetryDelay(envelope.attemptCount + 1),
            error: safeString(
              (result as any)?.errorMessage || "chat_inbound_retry_needed",
            ),
          });
          return;
        }
        completeChatInboxFile(claimedPath);
      } catch (error) {
        logger.warn(
          `chat inbox drain failed file=${claimedPath} err=${safeString((error as any)?.message || error)}`,
        );
        requeueChatInboxFile(runtime.agentDir, claimedPath, envelope, {
          delayMs: computeChatInboxRetryDelay(envelope.attemptCount + 1),
          error: safeString((error as any)?.message || error),
        });
      } finally {
        activeInboxRuns.delete(claimedPath);
      }
    })();
    activeInboxRuns.set(claimedPath, run);
    void run;
  };

  const drainChatInbox = async () => {
    for (const filePath of listPendingChatInboxFiles(runtime.agentDir)) {
      let claimedPath = "";
      try {
        claimedPath = claimChatInboxFile(runtime.agentDir, filePath);
      } catch {
        continue;
      }
      if (!claimedPath) continue;
      const envelope = readChatInboxItem(claimedPath);
      if (!envelope) {
        completeChatInboxFile(claimedPath);
        continue;
      }
      const nextAttemptAt = Date.parse(
        safeString(envelope.nextAttemptAt || "").trim(),
      );
      if (Number.isFinite(nextAttemptAt) && nextAttemptAt > Date.now()) {
        restoreChatInboxFile(runtime.agentDir, claimedPath, envelope);
        continue;
      }
      const controller = envelope.chatKey
        ? getController(envelope.chatKey)
        : null;
      if (controller?.claimsInboundMessage(envelope.messageId)) {
        completeChatInboxFile(claimedPath);
        continue;
      }
      if (isInboundMessageProcessed(envelope.chatKey, envelope.messageId)) {
        completeChatInboxFile(claimedPath);
        continue;
      }
      dispatchClaimedInboxItem(claimedPath, envelope);
    }
  };

  app.on("message", (session: any) => {
    void (async () => {
      const identity = getIdentity();
      const elements = ensureSessionElements(session);
      try {
        persistInboundMessage(
          runtime.agentDir,
          session,
          elements,
          identity,
          trustOf,
        );
        const logEntry = buildInboundChatLogInput(session, elements, {
          timestamp: new Date().toISOString(),
        });
        if (logEntry) {
          appendChatLog(runtime.agentDir, logEntry);
        }
      } catch (error: any) {
        logger.warn(
          `chat inbound save failed err=${safeString(error?.message || error)}`,
        );
      }

      await drainChatInbox();
    })().catch((error: any) => {
      logger.warn(
        `chat inbound handling failed err=${safeString(error?.message || error)}`,
      );
    });
  });

  inboxPollTimer = setInterval(() => {
    void drainChatInbox().catch((error: any) => {
      logger.warn(
        `chat inbox polling failed err=${safeString(error?.message || error)}`,
      );
    });
  }, CHAT_INBOX_POLL_INTERVAL_MS);

  app.on("bot-status-updated", (bot: any) => {
    if (bot?.status !== 1) return;
    void syncTelegramCommands(app, logger, commandRows);
  });

  const startedAt = new Date().toISOString();
  const send = async (payload: ChatOutboxPayload) => {
    await sendOutboxPayload(app, runtime.agentDir, payload, h);
    return { delivered: true as const };
  };
  const runTurn = async (payload: ChatBridgeTurnPayload) => {
    const chatKey = safeString(payload?.chatKey).trim();
    const text = safeString(payload?.text).trim();
    const { sessionFile } = normalizeSessionRef(payload);
    const controllerKey =
      safeString(payload?.controllerKey).trim() || "default";
    const deliveryEnabled = payload?.deliveryEnabled !== false;
    const affectChatBinding = payload?.affectChatBinding !== false;
    const disposeAfterTurn = payload?.disposeAfterTurn === true;
    if (!text) throw new Error("chat_text_required");
    const useBoundController = Boolean(
      chatKey &&
      controllerKey === "default" &&
      deliveryEnabled &&
      affectChatBinding,
    );
    const controller = useBoundController
      ? getController(chatKey)
      : getDetachedController(controllerKey, {
          chatKey,
          deliveryEnabled,
          affectChatBinding,
        });
    try {
      return await controller.runTurn(
        {
          text,
          attachments: [],
          sessionFile,
          managedSessionLeaf: payload?.managedSessionLeaf,
          model: payload?.model,
          thinkingLevel: payload?.thinkingLevel,
        },
        "prompt",
      );
    } finally {
      if (!useBoundController && disposeAfterTurn) {
        controller.dispose();
        detachedControllers.delete(controllerKey);
        try {
          fs.rmSync(
            path.join(
              dataDir,
              "cron-turns",
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
        timestamp: new Date().toISOString(),
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
        timestamp: new Date().toISOString(),
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
  logger.info(
    `chat bridge started bots=${JSON.stringify(app.bots.map((bot: any) => ({ platform: bot.platform, selfId: bot.selfId, status: bot.status })))}`,
  );

  const restoredInboxItems = restoreProcessingChatInboxFiles(runtime.agentDir);
  if (restoredInboxItems.length) {
    logger.warn(
      `chat inbox restored stranded processing items count=${restoredInboxItems.length}`,
    );
  }

  void drainChatInbox().catch((error: any) => {
    logger.warn(
      `chat inbox startup drain failed err=${safeString(error?.message || error)}`,
    );
  });

  let stoppingPromise: Promise<void> | null = null;
  const stop = async () => {
    if (stoppingPromise) return await stoppingPromise;
    stoppingPromise = (async () => {
      clearInterval(typingPollTimer);
      if (inboxPollTimer) clearInterval(inboxPollTimer);
      for (const controller of controllers.values()) controller.dispose();
      for (const controller of detachedControllers.values())
        controller.dispose();
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

  return { app, options, stop, getStatus, send, runTurn, evalBridge };
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
