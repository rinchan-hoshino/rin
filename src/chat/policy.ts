import type { ChatConfig, AdapterConfig, ChatMessage, ChatRule, QuietValue, Binding } from './types.js';
import {isAbsolute} from 'node:path';
export const adapterTypes = ['discord', 'telegram', 'onebot'];

export function validateConfig(config: ChatConfig) {
  if (!Array.isArray(config.adapters) || !Array.isArray(config.bindings)) throw new Error('adapters and bindings must be arrays');
  if(!config.agent)config.agent={type:'codex',...(config.codex || {})};
  if(typeof config.agent!=='object' || !['codex','claude-code','pi','opencode'].includes(config.agent.type))throw new Error('agent.type must be codex, claude-code, pi, or opencode');
  if(config.agent.type==='codex') {
    if(config.agent.command!==undefined && (!Array.isArray(config.agent.command) || !config.agent.command.length || config.agent.command.some(value=>typeof value!=='string' || !value)))throw new Error('agent.command must be a non-empty argv array for Codex');
    if(config.agent.codexHome!==undefined && (typeof config.agent.codexHome!=='string' || !isAbsolute(config.agent.codexHome)))throw new Error('agent.codexHome must be an absolute path');
    if(config.agent.endpoint!==undefined && (typeof config.agent.endpoint!=='string' || !/^(unix:\/\/|wss?:\/\/)/.test(config.agent.endpoint)))throw new Error('agent.endpoint must be a WebSocket or Unix socket URL');
    for(const name of ['queueTimeoutMs','pollMs'] as const)if(config.agent[name]!==undefined && (!Number.isFinite(config.agent[name]) || config.agent[name]!<=0))throw new Error(`agent.${name} must be positive`);
  } else {
    if(config.agent.command!==undefined && (typeof config.agent.command!=='string' || !config.agent.command))throw new Error('agent.command must be a non-empty executable');
    if(config.agent.cwd!==undefined && (typeof config.agent.cwd!=='string' || !isAbsolute(config.agent.cwd)))throw new Error('agent.cwd must be an absolute path');
    if(config.agent.extraArgs!==undefined && (!Array.isArray(config.agent.extraArgs) || config.agent.extraArgs.some(value=>typeof value!=='string')))throw new Error('agent.extraArgs must be an array of strings');
    if(config.agent.env!==undefined && (!config.agent.env || typeof config.agent.env!=='object' || Array.isArray(config.agent.env) || Object.values(config.agent.env).some(value=>typeof value!=='string')))throw new Error('agent.env must contain string values');
  }
  const ids = new Set();
  for (const a of config.adapters) {
    if (!a.id || ids.has(a.id)) throw new Error('Each adapter requires a unique id');
    if (!adapterTypes.includes(a.type)) throw new Error(`Unsupported adapter type: ${a.type}`);
    if (!Array.isArray(a.allowUsers) || a.allowUsers.some(x => typeof x !== 'string')) throw new Error(`allowUsers must be an array of user IDs: ${a.id}`);
    if (a.enabled !== false && a.allowUsers.length === 0) throw new Error(`Enabled adapter requires an explicit allowUsers list: ${a.id}`);
    if (a.ownerUsers !== undefined && (!Array.isArray(a.ownerUsers) || a.ownerUsers.some(x => typeof x !== 'string'))) throw new Error(`ownerUsers must be an array of explicit user IDs: ${a.id}`);
    for(const [name,rules] of [['allowChats',a.allowChats],['denyChats',a.denyChats]] as const)if(rules!==undefined && (!Array.isArray(rules) || rules.some(rule=>!validChatRule(rule))))throw new Error(`${name} must contain chat IDs or {chatId, topicId} rules: ${a.id}`);
    if (a.autoBind !== undefined && a.autoBind !== false) {
      if(config.agent.type!=='codex')throw new Error('autoBind is available only for the Codex agent; bind an existing session ID');
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
    if (threads.has(b.threadId)) throw new Error('One agent session may bind only one chat; cross-chat mirroring is not supported');
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

function validChatRule(rule: unknown): rule is ChatRule {
  return typeof rule==='string' && Boolean(rule) || Boolean(rule && typeof rule==='object' && !Array.isArray(rule) &&
    typeof (rule as {chatId?:unknown}).chatId==='string' && (rule as {chatId:string}).chatId &&
    ((rule as {topicId?:unknown}).topicId===undefined || typeof (rule as {topicId?:unknown}).topicId==='string' && Boolean((rule as {topicId:string}).topicId)));
}

function matchesChat(rule: ChatRule,message: Pick<ChatMessage,'chatId'|'topicId'>) {
  if(typeof rule==='string')return rule===String(message.chatId);
  return rule.chatId===String(message.chatId) && (rule.topicId===undefined || rule.topicId===String(message.topicId || ''));
}

export function chatAllowed(adapter: AdapterConfig,message: Pick<ChatMessage,'chatId'|'topicId'>) {
  if(adapter.denyChats?.some(rule=>matchesChat(rule,message)))return false;
  return !adapter.allowChats || adapter.allowChats.some(rule=>matchesChat(rule,message));
}

export function quietEnabled(value: QuietValue | undefined) {
  return value===true || value==='quiet' || Boolean(value && typeof value==='object' && (value.enabled===true || value.quiet===true || value.mode==='quiet'));
}

export function quietFor(config: ChatConfig,binding: Pick<Binding,'adapter'|'chatId'|'topicId'>) {
  const key=binding.topicId ? JSON.stringify([binding.adapter,String(binding.chatId),String(binding.topicId)]) : JSON.stringify([binding.adapter,String(binding.chatId)]);
  const override=config.quiet?.byRoute?.[key];
  return quietEnabled(override===undefined ? config.quiet?.default : override);
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
  if(!command && !chatAllowed(adapter,message))return false;
  // Legacy commands were authenticated by sender identity and command registry.
  // Mentioning only gates ordinary group conversation.
  if (message.kind === 'group' && !privateLike && adapter.requireMention !== false && !message.mentioned && !command) return false;
  // A direct message or a bot-mentioned group reply can consist solely of a
  // native reply reference. The context is resolved separately; do not discard
  // its stable source id before that stage.
  return Boolean(message.id && message.chatId && (message.text || message.files?.length || message.replyTo || message.reply || message.forward));
}

// Preserve readable agent text without introducing bridge-specific markup.
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
