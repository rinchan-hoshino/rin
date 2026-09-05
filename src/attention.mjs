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
  return {
    messageId: message.id,
    ...(message.messageId ? { platformMessageId: message.messageId } : {}),
    chatKey: message.chatKey,
    priority: isOwner ? 100 : 20,
    reason: isOwner ? "owner" : "ambient",
    nextCheckAt: isOwner
      ? new Date(Date.parse(message.receivedAt)).toISOString()
      : nextFixedWindow(message.receivedAt, options.ambientWindowMs),
  };
}

export function createAttentionState(lastMessageId) {
  return {
    version: 1,
    ...(lastMessageId ? { lastMessageId } : {}),
    pending: [],
  };
}

export function enqueueAttention(state, item) {
  if (!item) return;
  if (state.pending.some((candidate) => candidate.messageId === item.messageId)) return;
  if (state.emitting?.items.some((candidate) => candidate.messageId === item.messageId)) return;
  state.pending.push(item);
}

export function prepareDueBatch(state, nowMs) {
  if (state.emitting) return state.emitting;
  const due = state.pending
    .filter((item) => Date.parse(item.nextCheckAt) <= nowMs)
    .sort((left, right) => left.messageId.localeCompare(right.messageId));
  if (due.length === 0) return undefined;
  const dueIds = new Set(due.map((item) => item.messageId));
  state.pending = state.pending.filter((item) => !dueIds.has(item.messageId));
  const digest = crypto
    .createHash("sha256")
    .update(due.map((item) => item.messageId).join("\n"))
    .digest("hex");
  state.emitting = {
    id: digest,
    dedupeKey: `chat-attention:${digest}`,
    createdAt: new Date(nowMs).toISOString(),
    maxPriority: Math.max(...due.map((item) => item.priority)),
    items: due,
  };
  return state.emitting;
}

export function completeEmittingBatch(state, batchId) {
  if (state.emitting?.id === batchId) state.emitting = undefined;
}
