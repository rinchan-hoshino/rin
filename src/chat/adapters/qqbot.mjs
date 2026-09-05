import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { admitted } from '../policy.mjs';
import { COMMANDS, parseCommand, registerCommands } from '../commands.mjs';
import { syncQQCommandPanels } from '../qq-commands.mjs';

const capabilities = Object.freeze({ edit: false, delete: false, typing: true, maxText: 2000 });

function logger(log = {}) {
  return {
    debug: (...args) => {
      // SDK debug payloads may contain message bodies: retain only event type.
      const text = String(args[0] || '');
      const event = /Dispatch event: t=([A-Z_]+)/.exec(text)?.[1];
      if (event) log.info?.('QQ gateway event', { event });
      else if (text.includes('inbound message has no reply target')) log.warn?.('QQ inbound message skipped: no reply target');
      else log.debug?.(...args);
    },
    info: (...args) => log.info?.(...args),
    warn: (...args) => log.warn?.(...args),
    error: (...args) => log.error?.(...args),
  };
}

function safeName(value, fallback) {
  const name = path.basename(value || fallback).replaceAll(/[^\p{L}\p{N}._-]/gu, '_');
  return name || fallback;
}

async function readLimited(response, limit) {
  if (!response.body?.[Symbol.asyncIterator]) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error('QQ attachment exceeds 20 MB limit');
    return bytes;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) { await response.body.cancel?.(); throw new Error('QQ attachment exceeds 20 MB limit'); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

async function downloadAttachments(msg, config, context) {
  const attachments = msg.attachments || [];
  if (!attachments.length) return [];
  const dir = path.join(context.dataDir, 'attachments', safeName(config.id, 'qqbot'), randomUUID());
  await mkdir(dir, { recursive: true });
  return Promise.all(attachments.map(async (attachment, index) => {
    const url = attachment.url || attachment.voice_wav_url;
    if (!url) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.attachmentTimeoutMs ?? 15000);
    timer.unref?.();
    const response = await (config.fetch || fetch)(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`QQ attachment download failed: HTTP ${response.status}`);
    const declared = Number(response.headers?.get?.('content-length') || 0);
    if (declared > 20 * 1024 * 1024) throw new Error('QQ attachment exceeds 20 MB limit');
    const bytes = await readLimited(response, 20 * 1024 * 1024);
    clearTimeout(timer);
    const name = `${randomUUID()}-${safeName(attachment.filename, `attachment-${index + 1}`)}`;
    const filePath = path.join(dir, name);
    await writeFile(filePath, bytes);
    return { path: filePath, name, mimeType: attachment.content_type };
  })).then((items) => items.filter(Boolean));
}

export function createAdapter(config, context) {
  if (!config?.appId || !config?.appSecret) throw new Error('QQ official adapter requires appId and appSecret');
  if (!Array.isArray(config.allowUsers) || config.allowUsers.length === 0) throw new Error('QQ official adapter requires a non-empty allowUsers list');
  let bot;
  let startPromise;
  let handler;
  const commands = Array.isArray(context.commands) ? context.commands : COMMANDS;

  function targetFor(target) {
    return {
      scope: target.kind === 'group' ? 'group' : 'c2c',
      targetId: String(target.chatId),
      ...(target.messageId ? { msgId: String(target.messageId) } : {}),
    };
  }

  return {
    capabilities,
    async start(onMessage) {
      if (bot) throw new Error('QQ official adapter already started');
      const sdk = config.sdk || await import('@tencent-connect/qqbot-nodejs');
      bot = config.bot || new sdk.QQBot({
        appId: config.appId,
        appSecret: config.appSecret,
        accountId: config.id,
        logger: logger(context.log),
        transport: config.transport || 'websocket',
        ...(config.transport === 'webhook' ? { webhook: { port: config.port, path: config.path } } : {}),
        ...(config.intents == null ? {} : { intents: config.intents }),
      });
      handler = async (_ctx, msg) => {
        if (msg.kind !== 'c2c' && msg.kind !== 'group') {
          context.log?.warn?.(`QQ official adapter ignores unsupported ${msg.kind} conversation`);
          return;
        }
        const kind = msg.kind === 'group' ? 'group' : 'dm';
        const userId = String(msg.senderId);
        const text = String(msg.content || '').trim();
        // Admission deliberately precedes every attachment fetch.
        if (!admitted({...config,type:'qqbot'},userId,kind,{command:Boolean(parseCommand(text,commands))})) {
          context.log?.info?.('QQ message rejected by admission', {
            adapter: config.id, userId, kind,
            chatId: String(msg.kind === 'group' ? msg.groupOpenid : msg.senderId),
          });
          return;
        }
        const mentioned = msg.kind !== 'group' || /AT_MESSAGE_CREATE/.test(msg.rawEventType || '') || (msg.mentions?.length || 0) > 0;
        if (msg.kind === 'group' && config.requireMention !== false && !mentioned) {
          context.log?.info?.('QQ message ignored: mention required', {userId,kind});
          return;
        }
        const envelope = {
          id: String(msg.messageId),
          chatId: String(msg.kind === 'group' ? msg.groupOpenid : msg.senderId),
          userId,
          kind,
          mentioned: msg.kind === 'group' ? mentioned : false,
          text,
          files: [],
          ...(msg.refMsgIdx ? { replyTo: String(msg.refMsgIdx) } : {}),
        };
        if (context.isBound && !await context.isBound(envelope)) {
          context.log?.info?.('QQ message ignored: chat not bound', {userId,kind,chatId:envelope.chatId});
          return;
        }
        const files = await downloadAttachments(msg, config, context);
        await onMessage({ ...envelope, files });
      };
      bot.on('message', handler);
      bot.on('error', (error) => context.log?.error?.('QQ official adapter error', error));
      // QQBot.start stays pending for the lifetime of the connection.
      startPromise = Promise.resolve(bot.start()).catch((error) => {
        if (bot) context.log?.error?.('QQ official adapter stopped unexpectedly', error);
      });
      await registerCommands(async()=>{
        try { await syncQQCommandPanels(bot,config,context.commands); }
        catch (error) {
          const message = String(error?.message || '');
          const reason = /^qq_command_panel_sync_failed:[a-z0-9_:,.-]+$/.test(message)
            ? message : 'qq_command_panel_sync_failed:unknown';
          context.log?.warn?.(`QQ command panel registration failed (${reason})`);
        }
      },context.log,'QQ command panel registration failed');
    },
    async stop() {
      const current = bot;
      bot = undefined;
      if (current && handler) current.off?.('message', handler);
      await current?.stop?.();
      await Promise.race([startPromise || Promise.resolve(), new Promise((resolve) => setTimeout(resolve, 100))]);
    },
    async send(target, output) {
      if (!bot) throw new Error('QQ official adapter is not started');
      if (output.editId) throw new Error('QQ official bot API does not support editing sent messages');
      const qqTarget = targetFor({ ...target, messageId: output.replyTo || target.messageId });
      let result;
      if (output.text) result = await bot.sendText(qqTarget, String(output.text));
      for (const file of output.files || []) {
        const mime = file.mimeType || '';
        const method = mime.startsWith('image/') ? 'sendImage' : mime.startsWith('audio/') ? 'sendVoice' : mime.startsWith('video/') ? 'sendVideo' : 'sendFile';
        const media = await bot[method](qqTarget, { localPath: file.path }, file.name ? { fileName: file.name } : undefined);
        result ||= media?.message;
      }
      if (!result) throw new Error('QQ official send requires text or files');
      const id = result.id || result.message_id;
      if (id == null || id === '') throw new Error('QQ official send returned no message id');
      return { id: String(id) };
    },
    async typing(target) {
      if (!bot) throw new Error('QQ official adapter is not started');
      if (target.kind !== 'dm') throw new Error('QQ official typing indicator is supported only in C2C chats');
      await bot.sendTyping(targetFor(target));
    },
  };
}
