import type { ChatConfig, AdapterConfig, ChatMessage } from './types.js';
import {isAbsolute} from 'node:path';
export const adapterTypes = ['discord', 'telegram', 'qqbot', 'onebot'];

export function validateConfig(config: ChatConfig) {
  if (!Array.isArray(config.adapters) || !Array.isArray(config.bindings)) throw new Error('adapters and bindings must be arrays');
  const ids = new Set();
  for (const a of config.adapters) {
    if (!a.id || ids.has(a.id)) throw new Error('Each adapter requires a unique id');
    if (!adapterTypes.includes(a.type)) throw new Error(`Unsupported adapter type: ${a.type}`);
    if (!Array.isArray(a.allowUsers) || a.allowUsers.some(x => typeof x !== 'string')) throw new Error(`allowUsers must be an array of user IDs: ${a.id}`);
    if (a.enabled !== false && a.allowUsers.length === 0) throw new Error(`Enabled adapter requires an explicit allowUsers list: ${a.id}`);
    if (a.ownerUsers !== undefined && (!Array.isArray(a.ownerUsers) || a.ownerUsers.some(x => typeof x !== 'string'))) throw new Error(`ownerUsers must be an array of explicit user IDs: ${a.id}`);
    if (a.autoBind !== undefined && a.autoBind !== false) {
      const v=a.autoBind;
      if (!v || typeof v!=='object' || Array.isArray(v) || typeof v.cwd!=='string' || !isAbsolute(v.cwd) ||
        (v.model!==undefined && (typeof v.model!=='string' || !v.model.trim())) ||
        (v.excludedChatIds!==undefined && (!Array.isArray(v.excludedChatIds) || v.excludedChatIds.some(id=>typeof id!=='string')))) throw new Error('autoBind requires an absolute cwd and optional model/excludedChatIds');
    }
    ids.add(a.id);
  }
  const routes = new Set();
  const threads = new Set();
  for (const b of config.bindings) {
    if (!ids.has(b.adapter) || !b.chatId || !b.threadId || !['dm','group'].includes(b.kind) || (b.topicId !== undefined && (typeof b.topicId !== 'string' || !b.topicId))) throw new Error('Binding requires adapter, chatId, threadId, kind and an optional non-empty topicId');
    const key = b.topicId ? JSON.stringify([b.adapter,String(b.chatId),String(b.topicId)]) : JSON.stringify([b.adapter,String(b.chatId)]);
    if (routes.has(key)) throw new Error('Duplicate chat binding');
    routes.add(key);
    if (threads.has(b.threadId)) throw new Error('One Codex thread may bind only one chat; cross-chat mirroring is not supported');
    threads.add(b.threadId);
    const a = config.adapters.find(a => a.id === b.adapter)!;
    // A group binding on a DM-only adapter remains unreachable unless a fresh
    // private-like proof succeeds.  Do not reject an explicitly migrated owner
    // configuration before that runtime proof can run.
    if ((a.dmOnly ?? a.type === 'discord') && b.kind !== 'dm' && (!Array.isArray(a.ownerUsers) || a.ownerUsers.length === 0)) throw new Error('DM-only adapter cannot bind a group without explicit ownerUsers');
    if (b.mirror !== undefined && typeof b.mirror !== 'boolean') throw new Error('mirror must be boolean');
    if (b.mirror !== true) throw new Error('Explicit mirror:true is required: a bound chat receives future public output from this thread');
  }
  return config;
}

// Identity admission is shared by every adapter. dmOnly governs ordinary routing.
export function admitted(adapter: AdapterConfig, userId: unknown, kind: string, {command=false} = {}) {
  if (!Array.isArray(adapter.allowUsers) || !adapter.allowUsers.includes(String(userId))) return false;
  if (!['dm','group'].includes(kind)) return false;
  return command || !(adapter.dmOnly ?? adapter.type === 'discord') || kind === 'dm';
}

export function allowed(adapter: AdapterConfig, message: ChatMessage, {command = false}: {command?: boolean} = {}) {
  // allowUsers remains the universal admission list. ownerUsers never grants
  // admission and is only consumed by a separately proven private-like group.
  const privateLike = message.privateLike === true && Array.isArray(adapter.ownerUsers) && adapter.ownerUsers.includes(String(message.userId));
  const admissionKind = (message.kind === 'dm' || privateLike) ? 'dm' : message.kind;
  if (!admitted(adapter, message.userId, admissionKind, {command})) return false;
  // Legacy commands were authenticated by sender identity and command registry.
  // Mentioning only gates ordinary group conversation.
  if (message.kind === 'group' && !privateLike && adapter.requireMention !== false && !message.mentioned && !command) return false;
  // A direct message or a bot-mentioned group reply can consist solely of a
  // native reply reference. The context is resolved separately; do not discard
  // its stable source id before that stage.
  return Boolean(message.id && message.chatId && (message.text || message.files?.length || message.replyTo || message.reply || message.forward));
}

// Preserve readable Codex text, without introducing a bridge-specific markup language.
export function splitText(text: unknown, limit = 1900) {
  const chunks = [];
  let remaining = String(text ?? '');
  while (remaining.length > limit) {
    let at = remaining.lastIndexOf('\n', limit);
    if (at < limit / 2) at = limit;
    if (/[\uD800-\uDBFF]/.test(remaining[at - 1])) at--;
    chunks.push(remaining.slice(0, at));
    remaining = remaining.slice(at);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
