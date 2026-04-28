import fs from "node:fs";
import path from "node:path";

import { chatOutboxDir } from "../rin-lib/chat-outbox.js";
import {
  claimFileToDir,
  listJsonFiles,
  moveFileToDir,
  removeFileIfExists,
} from "../platform/fs.js";
import { safeString } from "./chat-helpers.js";
import { sendOutboxPayload } from "./transport.js";

export type ChatCommandRow = {
  name: string;
  description?: string;
};

const KOISHI_CHAT_COMMAND_ROWS: readonly ChatCommandRow[] = [
  { name: "help", description: "Show available commands" },
  { name: "abort", description: "Abort current operation" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Compact the current session" },
  {
    name: "reload",
    description: "Reload extensions, prompts, skills, and themes",
  },
  { name: "status", description: "Show current chat processing status" },
  { name: "session", description: "Show current session status" },
  { name: "model", description: "Show or change the current model" },
];

export function getChatCommandRows(): ChatCommandRow[] {
  return KOISHI_CHAT_COMMAND_ROWS.map((item) => ({ ...item }));
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

function readClaimedOutboxPayload(claimedPath: string) {
  try {
    return JSON.parse(fs.readFileSync(claimedPath, "utf8"));
  } catch (error: any) {
    throw new Error(
      `chat_outbox_invalid_json:${safeString(error?.message || error) || "parse_failed"}`,
    );
  }
}

function warnChatOutboxFailure(logger: any, filePath: string, error: unknown) {
  logger.warn(
    `chat outbox failed file=${filePath} err=${safeString((error as any)?.message || error)}`,
  );
}

function failClaimedOutboxFile(claimedPath: string, failedDir: string) {
  try {
    moveFileToDir(claimedPath, failedDir);
  } catch {}
}

async function drainClaimedOutboxFile(
  app: any,
  agentDir: string,
  h: any,
  claimedPath: string,
  failedDir: string,
  logger: any,
) {
  try {
    const payload = readClaimedOutboxPayload(claimedPath);
    await sendOutboxPayload(app, agentDir, payload, h);
    removeFileIfExists(claimedPath);
  } catch (error: any) {
    warnChatOutboxFailure(logger, claimedPath, error);
    failClaimedOutboxFile(claimedPath, failedDir);
  }
}

export async function drainChatOutbox(
  app: any,
  agentDir: string,
  h: any,
  logger: any,
) {
  const outboxDir = chatOutboxDir(agentDir);
  const failedDir = path.join(outboxDir, "failed");
  const processingDir = path.join(outboxDir, "processing");
  for (const filePath of listJsonFiles(outboxDir)) {
    const claimedPath = claimFileToDir(filePath, processingDir);
    if (!claimedPath) continue;
    await drainClaimedOutboxFile(
      app,
      agentDir,
      h,
      claimedPath,
      failedDir,
      logger,
    );
  }
}
