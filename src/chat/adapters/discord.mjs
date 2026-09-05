import {mkdir, writeFile} from 'node:fs/promises';
import {basename, extname, join} from 'node:path';
import {randomUUID} from 'node:crypto';

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 30_000;

function allowed(config, userId, kind) {
  const users = Array.isArray(config.allowUsers) ? config.allowUsers.map(String) : [];
  return users.length > 0 && users.includes(String(userId)) && (!(config.dmOnly ?? true) || kind === 'dm');
}

function cleanName(name = '') {
  const value = basename(String(name)).replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(-120);
  return value || 'attachment';
}

async function download(url, name, mimeType, dataDir, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let response;
  const chunks = [];
  let size = 0;
  try {
    response = await fetchImpl(url, {signal: controller.signal});
    if (!response.ok) throw new Error(`discord_attachment_download_failed:${response.status}`);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) throw new Error('discord_attachment_too_large');
    if (!response.body?.getReader) throw new Error('discord_attachment_stream_required');
    const reader = response.body.getReader();
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ATTACHMENT_BYTES) { await reader.cancel(); throw new Error('discord_attachment_too_large'); }
      chunks.push(Buffer.from(value));
    }
  } finally { clearTimeout(timeout); }
  const directory = join(dataDir, 'chat', 'attachments', 'discord');
  await mkdir(directory, {recursive: true});
  const safe = cleanName(name);
  const filePath = join(directory, `${Date.now()}-${randomUUID()}${extname(safe)}`);
  await writeFile(filePath, Buffer.concat(chunks, size));
  return {path: filePath, name: safe, mimeType: mimeType || undefined};
}

export function normalizeDiscordMessage(message, config, selfId = '') {
  if (!message || message.author?.bot || String(message.author?.id || '') === String(selfId)) return null;
  const userId = String(message.author?.id || '');
  const kind = message.guildId ? 'group' : 'dm';
  if (!userId || !allowed(config, userId, kind)) return null;
  const mentionTokens = selfId ? [`<@${selfId}>`, `<@!${selfId}>`] : [];
  const mentioned = kind === 'dm' || Boolean(message.mentions?.users?.has?.(String(selfId)));
  if (kind === 'group' && (config.requireMention ?? true) && !mentioned) return null;
  let text = String(message.content || '').trim();
  if (mentioned && kind === 'group') for (const token of mentionTokens) text = text.split(token).join('').trim();
  return {id: String(message.id), chatId: String(message.channelId), userId, kind, mentioned, text,
    replyTo: message.reference?.messageId ? String(message.reference.messageId) : undefined};
}

export function createAdapter(config, context) {
  let client;
  let handler;
  const fetchImpl = config.__fetch || globalThis.fetch;
  const capabilities = {edit: true, typing: true, maxText: 2000};

  async function receive(message) {
    const incoming = normalizeDiscordMessage(message, config, client?.user?.id);
    const bound = incoming && (!context.isBound || await context.isBound(incoming));
    if (context.observeDiscord && message?.author?.id && !message.author.bot && String(message.author.id)!==String(client?.user?.id)) {
      const ancestorIds=[];
      let current=message.channel;
      for(let depth=0;current && depth<4;depth++) {
        const parentId=current.parentId;
        if(!parentId || ancestorIds.includes(String(parentId)))break;
        ancestorIds.push(String(parentId));
        current=current.parent || client.guilds?.cache?.get?.(message.guildId)?.channels?.cache?.get?.(parentId);
        if(!current) {
          try { current=await client.guilds?.cache?.get?.(message.guildId)?.channels?.fetch?.(parentId); }
          catch { context.log?.warn?.('discord parent topology unavailable'); }
        }
      }
      const instance=String(client.user.id),chatKey=`discord/${instance}:${message.channelId}`;
      await context.observeDiscord({id:`${chatKey}:${message.id}`,messageId:String(message.id),platform:'discord',platformInstance:instance,adapterId:config.id,
        chatKey,chatType:message.guildId?'group':'dm',userId:String(message.author.id),authorName:message.member?.displayName || message.author.globalName || message.author.username || '',
        role:'user',text:String(message.content || ''),receivedAt:new Date(message.createdTimestamp || Date.now()).toISOString(),disposition:bound?'actionable':'record_only',ancestorIds,
        attachments:[...(message.attachments?.values?.() || [])].map(a=>({name:a.name,url:a.url,mimeType:a.contentType})),replyTo:message.reference?.messageId ? String(message.reference.messageId):undefined});
    }
    if (!incoming || !bound) return;
    const attachments = [];
    for (const item of message.attachments?.values?.() || []) {
      const url = item.url || item.proxyURL;
      if (url) attachments.push(await download(url, item.name, item.contentType, context.dataDir, fetchImpl));
    }
    await handler({...incoming, files: attachments});
  }

  async function channel(chatId) {
    const value = await client?.channels?.fetch?.(String(chatId));
    if (!value) throw new Error(`discord_channel_not_found:${chatId}`);
    return value;
  }

  async function ready() {
    if (client.isReady?.()) return;
    await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); client.off?.('ready', onReady); client.off?.('error', onError); };
      const onReady = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('discord_ready_failed')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('discord_ready_timeout')); }, READY_TIMEOUT_MS);
      client.once('ready', onReady); client.once('error', onError);
    });
  }

  return {
    capabilities,
    async start(onMessage) {
      if (!Array.isArray(config.allowUsers) || config.allowUsers.length === 0) throw new Error('discord_allow_users_required');
      if (!config.token) throw new Error('discord_token_required');
      handler = onMessage;
      if (config.__client) client = config.__client;
      else {
        const Discord = await import('discord.js');
        client = new Discord.Client({
          intents: [Discord.GatewayIntentBits.Guilds, Discord.GatewayIntentBits.GuildMessages,
            Discord.GatewayIntentBits.DirectMessages, Discord.GatewayIntentBits.MessageContent],
          partials: [Discord.Partials.Channel],
        });
      }
      client.on('messageCreate', message => receive(message).catch(error => context.log?.error?.('discord inbound failed', error)));
      await client.login(config.token);
      await ready();
    },
    async stop() { if (client) await client.destroy(); client = undefined; },
    async send(target, output) {
      const destination = await channel(target.chatId);
      const payload = {content: String(output.text || ''), allowedMentions: {parse: [], repliedUser: false}};
      if (output.files?.length) payload.files = output.files.map(file => ({attachment: file.path, name: file.name}));
      if (output.replyTo && !output.editId) payload.reply = {messageReference: String(output.replyTo), failIfNotExists: false};
      if (output.editId) {
        try {
          const message = await destination.messages.fetch(String(output.editId));
          const edited = await message.edit(payload);
          return {id: String(edited.id || output.editId)};
        } catch (error) {
          if (Number(error?.code) !== 10008) throw error;
          if (output.replyTo) payload.reply = {messageReference: String(output.replyTo), failIfNotExists: false};
          try { const sent = await destination.send(payload); return {id: String(sent.id)}; }
          catch (replacementError) { replacementError.deliveryUncertain = true; throw replacementError; }
        }
      }
      const sent = await destination.send(payload);
      return {id: String(sent.id)};
    },
    async typing(target) { const destination = await channel(target.chatId); await destination.sendTyping(); },
    async delete(target, messageId) {
      try {
        const destination = await channel(target.chatId);
        await destination.messages.delete(String(messageId));
      } catch (error) {
        if (error?.code === 10008 || /unknown message/i.test(String(error?.message || ''))) return;
        throw error;
      }
    },
  };
}
