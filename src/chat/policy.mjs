export const adapterTypes = ['discord', 'telegram', 'qqbot', 'onebot', 'feishu'];

export function validateConfig(config) {
  if (!Array.isArray(config.adapters) || !Array.isArray(config.bindings)) throw new Error('adapters and bindings must be arrays');
  const ids = new Set();
  for (const a of config.adapters) {
    if (!a.id || ids.has(a.id)) throw new Error('Each adapter requires a unique id');
    if (!adapterTypes.includes(a.type)) throw new Error(`Unsupported adapter type: ${a.type}`);
    if (!Array.isArray(a.allowUsers) || a.allowUsers.some(x => typeof x !== 'string')) throw new Error(`allowUsers must be an array of user IDs: ${a.id}`);
    if (a.enabled !== false && a.allowUsers.length === 0) throw new Error(`Enabled adapter requires an explicit allowUsers list: ${a.id}`);
    ids.add(a.id);
  }
  const routes = new Set();
  const threads = new Set();
  for (const b of config.bindings) {
    if (!ids.has(b.adapter) || !b.chatId || !b.threadId || !['dm','group'].includes(b.kind)) throw new Error('Binding requires adapter, chatId, threadId and kind');
    const key = JSON.stringify([b.adapter,b.chatId]);
    if (routes.has(key)) throw new Error('Duplicate chat binding');
    routes.add(key);
    if (threads.has(b.threadId)) throw new Error('One Codex thread may bind only one chat; cross-chat mirroring is not supported');
    threads.add(b.threadId);
    const a = config.adapters.find(a => a.id === b.adapter);
    if ((a.dmOnly ?? a.type === 'discord') && b.kind !== 'dm') throw new Error('DM-only adapter cannot bind a group');
    if (b.mirror !== undefined && typeof b.mirror !== 'boolean') throw new Error('mirror must be boolean');
    if (b.mirror !== true) throw new Error('Explicit mirror:true is required: a bound chat receives future public output from this thread');
  }
  return config;
}

// Identity admission is shared by every adapter. dmOnly governs ordinary routing.
export function admitted(adapter, userId, kind, {command=false} = {}) {
  if (!Array.isArray(adapter.allowUsers) || !adapter.allowUsers.includes(String(userId))) return false;
  if (!['dm','group'].includes(kind)) return false;
  return command || !(adapter.dmOnly ?? adapter.type === 'discord') || kind === 'dm';
}

export function allowed(adapter, message, options = {}) {
  if (!admitted(adapter, message.userId, message.kind, options)) return false;
  if (message.kind === 'group' && adapter.requireMention !== false && !message.mentioned) return false;
  return Boolean(message.id && message.chatId && (message.text || message.files?.length));
}

// Preserve readable Codex text, without introducing a bridge-specific markup language.
export function splitText(text, limit = 1900) {
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
