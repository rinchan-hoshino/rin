import {admitted} from '../policy.mjs';
import {mkdir, writeFile} from 'node:fs/promises';
import {basename, extname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {COMMANDS, parseCommand, registerCommands} from '../commands.mjs';

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 30_000;

function explicitMediaRejection(error) {
  const status=Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  return Number.isFinite(status) && status>=400 && status<500;
}

function discordCommandDefinitions(commands) {
  return commands.map(command => ({
    name: command.name,
    description: command.description,
    type: 1,
    ...(command.argument ? {options: [{name: 'args', description: command.argument, type: 3, required: false}]} : {}),
  }));
}

function commandText(commands, name, args = '') {
  const command = commands.find(item => item.name === String(name || '').toLowerCase());
  if (!command) return '';
  const suffix = String(args || '').trim();
  return `/${command.name}${suffix ? ` ${suffix}` : ''}`;
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

export function normalizeDiscordMessage(message, config, selfId = '', commands = COMMANDS) {
  if (!message || message.author?.bot || String(message.author?.id || '') === String(selfId)) return null;
  const userId = String(message.author?.id || '');
  const kind = message.guildId ? 'group' : 'dm';
  const mentionTokens = selfId ? [`<@${selfId}>`, `<@!${selfId}>`] : [];
  const mentioned = kind === 'dm' || Boolean(message.mentions?.users?.has?.(String(selfId)));
  if (kind === 'group' && (config.requireMention ?? true) && !mentioned) return null;
  let text = String(message.content || '').trim();
  if (mentioned && kind === 'group') for (const token of mentionTokens) text = text.split(token).join('').trim();
  if (!userId || !admitted({...config,type:'discord'},userId,kind,{command:Boolean(parseCommand(text,commands))}))return null;
  return {id: String(message.id), chatId: String(message.channelId), userId, kind, mentioned, text,
    replyTo: message.reference?.messageId ? String(message.reference.messageId) : undefined};
}

export function createAdapter(config, context) {
  const commands = Array.isArray(context.commands) ? context.commands : COMMANDS;
  const discordCommands = discordCommandDefinitions(commands);
  let client;
  let handler;
  const interactions = new Map();
  const pendingInteractions = new Set();
  const fetchImpl = config.__fetch || globalThis.fetch;
  const capabilities = {edit: true, typing: true, maxText: 2000};

  async function receive(message) {
    const incoming = normalizeDiscordMessage(message, config, client?.user?.id, commands);
    const bound = incoming && (!context.isBound || await context.isBound(incoming));
    let commandSource=String(message?.content || '').trim();
    for(const token of client?.user?.id ? [`<@${client.user.id}>`,`<@!${client.user.id}>`] : [])commandSource=commandSource.split(token).join('').trim();
    const commandMatch = /^\/([a-z0-9_]+)(?:\s|$)/i.exec(commandSource);
    const recognizedCommand = context.isCommand
      ? Boolean(context.isCommand({text: commandSource}))
      : Boolean(commandMatch && commands.some(command => command.name === commandMatch[1].toLowerCase()));
    if (!recognizedCommand && context.observeDiscord && message?.author?.id && !message.author.bot && String(message.author.id)!==String(client?.user?.id)) {
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
        mentionedBot:Boolean(client?.user?.id && message.mentions?.users?.has?.(client.user.id)),
        attachments:[...(message.attachments?.values?.() || [])].map(a=>({name:a.name,url:a.url,mimeType:a.contentType})),replyTo:message.reference?.messageId ? String(message.reference.messageId):undefined});
    }
    if (!incoming || !bound) return;
    if (recognizedCommand) { await handler({...incoming, files: []}); return; }
    const attachments = [];
    for (const item of message.attachments?.values?.() || []) {
      const url = item.url || item.proxyURL;
      if (url) attachments.push(await download(url, item.name, item.contentType, context.dataDir, fetchImpl));
    }
    await handler({...incoming, files: attachments});
  }

  async function receiveInteraction(interaction) {
    if (!interaction?.isChatInputCommand?.()) return;
    const userId = String(interaction.user?.id || '');
    const kind = interaction.guildId ? 'group' : 'dm';
    const text = commandText(commands, interaction.commandName, interaction.options?.getString?.('args'));
    if (!text || !admitted({...config,type:'discord'},userId,kind,{command:true}) || interaction.user?.bot) return;
    const interactionId = String(interaction.id);
    if (pendingInteractions.has(interactionId) || interactions.has(interactionId)) return;
    pendingInteractions.add(interactionId);
    const incoming = {
      id: interactionId, chatId: String(interaction.channelId), userId, kind,
      mentioned: true, text, files: [], commandInteraction: {id: interactionId},
    };
    try {
      if (context.isBound && !await context.isBound(incoming)) return;
      try { await interaction.deferReply({ephemeral: true}); }
      catch { throw new Error('discord_command_interaction_ack_failed'); }
      const timer = setTimeout(() => interactions.delete(interactionId), 15 * 60_000);
      timer.unref?.();
      interactions.set(interactionId, {interaction, timer});
      try { await handler(incoming); }
      catch (error) { clearTimeout(timer); interactions.delete(interactionId); throw error; }
    } finally { pendingInteractions.delete(interactionId); }
  }

  async function syncCommands() {
    const set = client?.application?.commands?.set;
    if (typeof set !== 'function') throw new Error('discord_application_command_api_missing');
    // Global is authoritative. Old guild commands shadow it in the picker.
    await set.call(client.application.commands, discordCommands);
    const guildIds=new Set((config.commandGuildIds || []).map(String));
    for(const id of client.guilds?.cache?.keys?.() || [])guildIds.add(String(id));
    if(typeof client.guilds?.fetch==='function') {
      const guilds=await client.guilds.fetch();
      for(const id of guilds.keys())guildIds.add(String(id));
    }
    for(const guildId of guildIds)await set.call(client.application.commands, [], guildId);
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
      client.on('interactionCreate', interaction => receiveInteraction(interaction).catch(() => context.log?.error?.('Discord command handling failed')));
      await client.login(config.token);
      await ready();
      await registerCommands(syncCommands,context.log,'Discord command registration failed');
    },
    async stop() {
      pendingInteractions.clear();
      for (const value of interactions.values()) clearTimeout(value.timer);
      interactions.clear();
      if (client) await client.destroy(); client = undefined;
    },
    async send(target, output) {
      const payload = {content: String(output.text || ''), allowedMentions: {parse: [], repliedUser: false}};
      if (output.files?.length) payload.files = output.files.map(file => ({attachment: file.path, name: file.name}));
      const interactionId = target.commandInteraction?.id;
      if (interactionId) {
        const entry = interactions.get(String(interactionId));
        if (!entry) throw new Error('discord_command_interaction_unavailable');
        const {interaction, timer} = entry;
        let chunks=[]; const content=payload.content;
        for(let index=0;index<content.length;index+=2000)chunks.push(content.slice(index,index+2000));
        if(!chunks.length)chunks.push('');
        let edited;
        try { edited = await interaction.editReply({...payload,content:chunks[0]}); }
        catch {
          if (!payload.files?.length) throw new Error('discord_command_interaction_response_failed');
          const fallback=String(output.fallbackText || chunks[0] || '附件发送失败，请在 Codex 中查看。');
          chunks=[];for(let index=0;index<fallback.length;index+=2000)chunks.push(fallback.slice(index,index+2000));
          try { edited = await interaction.editReply({content:chunks[0],allowedMentions:payload.allowedMentions,files:[],attachments:[]}); }
          catch { throw new Error('discord_command_interaction_response_failed'); }
        }
        for(const contentPart of chunks.slice(1)) {
          try { await interaction.followUp({content:contentPart,ephemeral:true,allowedMentions:payload.allowedMentions}); }
          catch { throw new Error('discord_command_interaction_followup_failed'); }
        }
        clearTimeout(timer); interactions.delete(String(interactionId));
        return {id: String(edited?.id || interactionId)};
      }
      const destination = await channel(target.chatId);
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
      try { const sent = await destination.send(payload); return {id: String(sent.id)}; }
      catch(error) { if(payload.files?.length && explicitMediaRejection(error))error.fallbackSafe=true;throw error; }
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
