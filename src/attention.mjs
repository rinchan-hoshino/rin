import crypto from "node:crypto";

// Attention policy ported from the previous Rin. Persistence and transport live outside this module.

function chatId(chatKey) {
  const separator = chatKey.indexOf(":");
  return separator >= 0 ? chatKey.slice(separator + 1) : "";
}

function nextFixedWindow(receivedAt, windowMs) {
  const receivedMs = Date.parse(receivedAt);
  if (!Number.isFinite(receivedMs) || !Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new Error("chat_attention_time_invalid");
  }
  return new Date(Math.ceil(receivedMs / windowMs) * windowMs).toISOString();
}

export function classifyStoredMessage(message, options) {
  if (options.ignoredChatKeys?.has(message.chatKey)) return undefined;
  if (
    message.role !== "user" ||
    message.disposition !== "record_only" ||
    !message.id ||
    !message.chatKey
  ) {
    return undefined;
  }
  if (
    message.platform === "discord" &&
    options.mirrorDiscordChannelIds.has(chatId(message.chatKey))
  ) {
    return undefined;
  }
  const isOwner =
    message.trust === "OWNER" &&
    typeof message.userId === "string" &&
    options.ownerUserIds.has(message.userId);
  const channel = options.channels?.[message.chatKey] || {};
  const ambient = channel.mode === "ambient" || !isOwner;
  const mentioned = message.mentionedBot === true;
  const awaiting = options.awaitingReply === true;
  const idleDelayMs = channel.idleDelayMs ?? (ambient ? options.ambientWindowMs : 30_000);
  const maxDelayMs = channel.maxDelayMs ?? (ambient ? options.ambientWindowMs : 300_000);
  const priority = mentioned ? 100 : awaiting ? 90 : isOwner ? 60 : 20;
  const receivedMs = Date.parse(message.receivedAt);
  if (!Number.isFinite(receivedMs)) throw new Error("chat_attention_time_invalid");
  return {
    messageId: message.id,
    ...(message.messageId ? { platformMessageId: message.messageId } : {}),
    chatKey: message.chatKey,
    receivedAt: new Date(receivedMs).toISOString(),
    priority,
    reason: mentioned ? "mentioned" : awaiting ? "awaiting_reply" : isOwner ? "owner" : "ambient",
    idleOnly: channel.idleOnly ?? ambient,
    nextCheckAt: ambient && idleDelayMs === options.ambientWindowMs
      ? nextFixedWindow(message.receivedAt, idleDelayMs)
      : new Date(receivedMs + (priority >= 90 ? 0 : idleDelayMs)).toISOString(),
    latestCheckAt: new Date(receivedMs + maxDelayMs).toISOString(),
  };
}

export function createAttentionState(lastMessageId) {
  return {
    version: 2,
    ...(lastMessageId ? { lastMessageId } : {}),
    pending: [],
    chats: {},
  };
}

export function normalizeAttentionState(value) {
  const state = value && typeof value === "object" ? value : createAttentionState();
  state.version = 2;
  state.pending = Array.isArray(state.pending) ? state.pending : [];
  state.chats = state.chats && typeof state.chats === "object" ? state.chats : {};
  for (const item of state.pending) {
    item.receivedAt ||= item.nextCheckAt;
    if (item.reason === "owner" && item.priority === 100) item.priority = 60;
    item.idleOnly ??= item.reason === "ambient";
    item.latestCheckAt ||= new Date(Date.parse(item.nextCheckAt) + (item.reason === "ambient" ? 0 : 300_000)).toISOString();
  }
  return state;
}

export function enqueueAttention(state, item) {
  if (!item) return;
  if (state.pending.some((candidate) => candidate.messageId === item.messageId)) return;
  if (state.emitting?.items.some((candidate) => candidate.messageId === item.messageId)) return;
  state.pending.push(item);
}

export function prepareDueBatch(state, nowMs, {active=false, chatModes={}} = {}) {
  if (state.emitting) return state.emitting;
  const due = state.pending
    .filter((item) => {
      const mode = chatModes[item.chatKey];
      const busy = mode === "busy" ? true : mode === "idle" || mode === "waiting" ? false : active;
      const earliest = Date.parse(item.nextCheckAt);
      const latest = Date.parse(item.latestCheckAt || item.nextCheckAt);
      if (item.priority >= 90) return nowMs >= Math.min(latest, earliest + (busy ? 30_000 : 0));
      if (item.idleOnly && busy) return nowMs >= latest;
      return nowMs >= (busy ? latest : earliest);
    })
    .sort((left, right) => left.messageId.localeCompare(right.messageId));
  if (due.length === 0) return undefined;
  const digest = crypto
    .createHash("sha256")
    .update(due.map((item) => `${item.messageId}\0${item.nextCheckAt}`).join("\n"))
    .digest("hex");
  state.emitting = {
    id: digest,
    dedupeKey: `chat-attention:${digest}`,
    createdAt: new Date(nowMs).toISOString(),
    maxPriority: Math.max(...due.map((item) => item.priority)),
    items: due,
  };
  for (const item of due) item.nextCheckAt = new Date(nowMs + (item.reason === "ambient" ? 900_000 : 300_000)).toISOString();
  return state.emitting;
}

export function completeEmittingBatch(state, batchId) {
  if (state.emitting?.id === batchId) state.emitting = undefined;
}
