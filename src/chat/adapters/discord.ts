import type {Client, Message, Interaction, ChatInputCommandInteraction, MessageCreateOptions, ApplicationCommandDataResolvable, GuildBasedChannel, TextBasedChannel, User} from 'discord.js';
interface DiscordConfig extends AdapterConfig { __client?: Client; __fetch?: typeof fetch; commandGuildIds?: string[]; }
import type { AdapterConfig, AdapterContext, ChatAdapter, ChatMessage, ChatTarget, ChatOutput, ChatCommand, CommandDescriptor, FileAttachment } from '../types.js';
import { platformError } from './types.js';
import {admitted} from '../policy.js';
import {mkdir, writeFile} from 'node:fs/promises';
import {basename, extname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {COMMANDS, parseCommand, parseCommandText, registerCommands} from '../commands.js';

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 30_000;

function explicitMediaRejection(value: unknown) {
  const error = platformError(value);
  const status=Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  return Number.isFinite(status) && status>=400 && status<500;
}

function discordCommandDefinitions(commands: readonly CommandDescriptor[]): ApplicationCommandDataResolvable[] {
  return commands.map(command => ({
    name: command.name,
    description: command.description,
    type: 1,
    ...(command.argument ? {options: [{name: 'args', description: command.argument, type: 3, required: false}]} : {}),
  }));
}

function commandText(commands: readonly CommandDescriptor[], name: string, args: string | null = '') {
  const command = commands.find(item => item.name === String(name || '').toLowerCase());
  if (!command) return '';
  const suffix = String(args || '').trim();
  return `/${command.name}${suffix ? ` ${suffix}` : ''}`;
}

function cleanName(name = '') {
  const value = basename(String(name)).replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(-120);
  return value || 'attachment';
}

async function download(url: string, name: string | null, mimeType: string | null, dataDir: string, fetchImpl: typeof fetch) {
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
  const safe = cleanName(name || '');
  const filePath = join(directory, `${Date.now()}-${randomUUID()}${extname(safe)}`);
  await writeFile(filePath, Buffer.concat(chunks, size));
  return {path: filePath, name: safe, mimeType: mimeType || undefined};
}

type DiscordSelf = string | Pick<User, 'id' | 'username'>;

function discordSelf(value: DiscordSelf = '') {
  if (typeof value === 'string') return {id: value, username: ''};
  return {id: String(value?.id || ''), username: String(value?.username || '').toLowerCase()};
}

export function normalizeDiscordMessage(message: Message, config: DiscordConfig, self: DiscordSelf = '', commands = COMMANDS): ChatMessage | null {
  const {id: selfId, username: selfUsername} = discordSelf(self);
  if (!message || message.author?.bot || String(message.author?.id || '') === String(selfId)) return null;
  const userId = String(message.author?.id || '');
  const kind = message.guildId ? 'group' : 'dm';
  const mentionTokens = selfId ? [`<@${selfId}>`, `<@!${selfId}>`] : [];
  const mentioned = kind === 'dm' || Boolean(message.mentions?.users?.has?.(String(selfId)));
  let text = String(message.content || '').trim();
  if (mentioned && kind === 'group') for (const token of mentionTokens) text = text.split(token).join('').trim();
  const parsed = parseCommandText(text,commands);
  const commandTarget = parsed?.target
    ? (parsed.target === String(selfId).toLowerCase() || parsed.target === selfUsername ? 'self' : 'other') : undefined;
  const command = Boolean(parseCommand(text,commands,commandTarget));
  if (!userId || !admitted({...config,type:'discord'},userId,kind,{command})) return null;
  if (kind === 'group' && (config.requireMention ?? true) && !mentioned && !command) return null;
  return {id: String(message.id), chatId: String(message.channelId), userId, kind, mentioned, text,
    ...(commandTarget ? {commandTarget} : {}),
    ...((message.channel && 'name' in message.channel ? message.channel.name : undefined) ? {chatName:String(message.channel && 'name' in message.channel ? message.channel.name : '').slice(0,100)} : {}),
    replyTo: message.reference?.messageId ? String(message.reference.messageId) : undefined};
}

export function createAdapter(config: DiscordConfig, context: AdapterContext) {
  const commands = Array.isArray(context.commands) ? context.commands : COMMANDS;
  const discordCommands = discordCommandDefinitions(commands);
  let client: Client | undefined;
  let handler: (message: ChatMessage) => Promise<void>;
  const interactions = new Map<string, {interaction: ChatInputCommandInteraction; timer: ReturnType<typeof setTimeout>}>();
  const pendingInteractions = new Set<string>();
  const fetchImpl = config.__fetch || globalThis.fetch;
  const capabilities = {edit: true, typing: true, maxText: 2000};

  async function receive(message: Message) {
    const incoming = normalizeDiscordMessage(message, config, client?.user || '', commands);
    const bound = incoming && (!context.isBound || await context.isBound(incoming));
    let commandSource=String(message?.content || '').trim();
    for(const token of client?.user?.id ? [`<@${client.user.id}>`,`<@!${client.user.id}>`] : [])commandSource=commandSource.split(token).join('').trim();
    const commandMatch = /^\/([a-z0-9_]+)(?:\s|$)/i.exec(commandSource);
    const recognizedCommand = context.isCommand
      ? Boolean(context.isCommand({text: commandSource}))
      : Boolean(commandMatch && commands.some(command => command.name === commandMatch[1].toLowerCase()));
    if (!incoming || !bound) return;
    if (recognizedCommand) { await handler({...incoming, files: []}); return; }
    const attachments = [];
    for (const item of message.attachments?.values?.() || []) {
      const url = item.url || item.proxyURL;
      if (url) attachments.push(await download(url, item.name, item.contentType, context.dataDir, fetchImpl));
    }
    await handler({...incoming, files: attachments});
  }

  async function receiveInteraction(interaction: Interaction) {
    if (!interaction?.isChatInputCommand?.()) return;
    const userId = String(interaction.user?.id || '');
    const kind = interaction.guildId ? 'group' : 'dm';
    const text = commandText(commands, interaction.commandName, interaction.options?.getString?.('args'));
    if (!text || !admitted({...config,type:'discord'},userId,kind,{command:true}) || interaction.user?.bot) return;
    const interactionId = String(interaction.id);
    if (pendingInteractions.has(interactionId) || interactions.has(interactionId)) return;
    pendingInteractions.add(interactionId);
    const incoming: ChatMessage = {
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
      catch (errorValue) { const error = platformError(errorValue); clearTimeout(timer); interactions.delete(interactionId); throw error; }
    } finally { pendingInteractions.delete(interactionId); }
  }

  async function syncCommands() {
    const set = client?.application?.commands?.set;
    if (typeof set !== 'function') throw new Error('discord_application_command_api_missing');
    // Global is authoritative. Old guild commands shadow it in the picker.
    await client!.application!.commands.set(discordCommands);
    const guildIds=new Set((config.commandGuildIds || []).map(String));
    for(const id of client!.guilds?.cache?.keys?.() || [])guildIds.add(String(id));
    if(typeof client!.guilds?.fetch==='function') {
      const guilds=await client!.guilds.fetch();
      for(const id of guilds.keys())guildIds.add(String(id));
    }
    for(const guildId of guildIds)await client!.application!.commands.set([], guildId);
  }

  async function channel(chatId: string) {
    const value = await client?.channels?.fetch?.(String(chatId));
    if (!value) throw new Error(`discord_channel_not_found:${chatId}`);
    return value;
  }

  async function ready() {
    if (client!.isReady?.()) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); client?.off?.('ready', onReady); client?.off?.('error', onError); };
      const onReady = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('discord_ready_failed')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('discord_ready_timeout')); }, READY_TIMEOUT_MS);
      client!.once('ready', onReady); client!.once('error', onError);
    });
  }

  return {
    capabilities,
    async start(onMessage: (message: ChatMessage) => Promise<void>) {
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
    async send(target: ChatTarget, output: ChatOutput): Promise<{id: string}> {
      const payload: Pick<MessageCreateOptions, 'allowedMentions' | 'files' | 'reply'> & {content: string} = {content: String(output.text || ''), allowedMentions: {parse: [], repliedUser: false}};
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
          const fallback=String(output.fallbackText || chunks[0] || '附件发送失败，请在所用 agent 中查看。');
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
      if (!('send' in destination)) throw new Error('discord_channel_not_sendable');
      if (output.replyTo && !output.editId) payload.reply = {messageReference: String(output.replyTo), failIfNotExists: false};
      if (output.editId) {
        try {
          const message = await destination.messages.fetch(String(output.editId));
          const edited = await message.edit(payload);
          return {id: String(edited.id || output.editId)};
        } catch (errorValue) { const error = platformError(errorValue);
          if (Number(error?.code) !== 10008) throw error;
          if (output.replyTo) payload.reply = {messageReference: String(output.replyTo), failIfNotExists: false};
          try { const sent = await destination.send(payload); return {id: String(sent.id)}; }
          catch (replacementErrorValue) { const replacementError = platformError(replacementErrorValue); replacementError.deliveryUncertain = true; throw replacementError; }
        }
      }
      try { const sent = await destination.send(payload); return {id: String(sent.id)}; }
      catch (errorValue) { const error = platformError(errorValue); if(payload.files?.length && explicitMediaRejection(error))error.fallbackSafe=true;throw error; }
    },
    async typing(target: ChatTarget) { const destination = await channel(target.chatId); if (!('sendTyping' in destination)) throw new Error('discord_channel_not_typable'); await destination.sendTyping(); },
    async delete(target: ChatTarget, messageId: string) {
      const interactionId=target.commandInteraction?.id;
      if(interactionId) {
        const entry=interactions.get(String(interactionId));
        if(!entry)throw new Error('discord_command_interaction_unavailable');
        try { await entry.interaction.deleteReply(); }
        catch(errorValue) {
          const error=platformError(errorValue);
          if(![10008,10015,10062].includes(Number(error?.code)))throw new Error('discord_command_interaction_dismiss_failed');
        }
        clearTimeout(entry.timer);interactions.delete(String(interactionId));return;
      }
      try {
        const destination = await channel(target.chatId);
        if (!('messages' in destination)) throw new Error('discord_channel_has_no_messages');
        await destination.messages.delete(String(messageId));
      } catch (errorValue) { const error = platformError(errorValue);
        if (error?.code === 10008 || /unknown message/i.test(String(error?.message || ''))) return;
        throw error;
      }
    },
  };
}
