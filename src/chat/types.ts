import type { ForwardContext, ReplyContext } from './input-normalization.js';
import type {AgentConfig,AgentEvent,CodexAgentConfig} from '../agents/types.js';
export type ChatKind = 'dm' | 'group';
export interface FileAttachment { path: string; name?: string; mimeType?: string; }
export interface ChatMessage { adapter?: string; replyTo?: string; reply?: ReplyContext; forward?: ForwardContext; /** Telegram message_thread_id; always separate from chatId. */ topicId?: string; /** A provider edit that may replace only an unsubmitted durable message. */ edited?: boolean; commandInteraction?: {id: string}; commandTarget?: 'self' | 'other'; id: string; chatId: string; userId: string; kind: ChatKind; text: string; files?: FileAttachment[]; mentioned?: boolean; /** A group backed by a fresh, complete owner-only membership proof. */ privateLike?: boolean; chatName?: string; userName?: string; }
export interface ChatTarget { commandInteraction?: {id: string}; chatId: string; /** Native thread/topic target, never concatenated with chatId. */ topicId?: string; kind?: ChatKind; userId?: string; messageId?: string; }
export interface ChatOutput { text?: string; files?: FileAttachment[]; editId?: string; replyTo?: string; target?: ChatTarget; delete?: boolean; progress?: boolean; fallbackText?: string; parseMode?: string; }
export interface Binding extends ChatTarget { adapter: string; threadId: string; kind: ChatKind; mirror: boolean; }
export interface AutoBind { cwd: string; model?: string; excludedChatIds?: string[]; }
export type ChatRule = string | {chatId: string; topicId?: string};
export interface AdapterConfig { id: string; type: string; enabled?: boolean; allowUsers: string[]; allowChats?: ChatRule[]; denyChats?: ChatRule[]; /** Explicit historic owner identities used only for private-like membership proofs. */ ownerUsers?: string[]; dmOnly?: boolean; requireMention?: boolean; autoBind?: AutoBind | false; token?: string; tokenEnv?: string; url?: string; [key: string]: unknown; }
export type QuietValue = boolean | 'quiet' | {enabled?: boolean; quiet?: boolean; mode?: string};
export interface ChatConfig { dataDir: string; adapters: AdapterConfig[]; bindings: Binding[]; agent?: AgentConfig; /** @deprecated Use agent:{type:'codex',...}. */ codex?: Omit<CodexAgentConfig,'type'>; attachmentRoots?: string[]; display?: {working?: WorkingConfig; summaries?: boolean}; quiet?: {default?: QuietValue; byRoute?: Record<string,QuietValue>}; commands?: {directory?: string}; }
export interface WorkingConfig { frames?: string[]; text?: string; intervalMs?: number; }
export interface Logger { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void; }
export interface CommandContext { args: string; message: ChatMessage; dataDir: string; }
export interface CommandDescriptor { name: string; description: string; argument?: string; privateOnly?: boolean; }
export interface ChatCommand extends CommandDescriptor { run(context: CommandContext): ChatOutput | void | null | Promise<ChatOutput | void | null>; }
export interface AttentionRecord { id: string; [key: string]: unknown; }
export interface AdapterContext { dataDir: string; log: Logger; commands: ChatCommand[]; getCursor<T = unknown>(key: string): T | undefined; setCursor(key: string, value: unknown): void; isCommand(message: Pick<ChatMessage, 'text'>): boolean; isBound(message: ChatMessage): boolean; }
export interface ChatAdapter { capabilities: {edit: boolean; reaction?: boolean; typing?: boolean; maxText?: number}; start(onMessage: (message: ChatMessage) => Promise<void>): Promise<void>; stop(): Promise<void>; send(target: ChatTarget, output: ChatOutput): Promise<{id: string | null}>; typing(target: ChatTarget): Promise<void>; startReaction?(target: ChatTarget): Promise<{id: string | null}>; endReaction?(target: ChatTarget, id: string): Promise<void>; delete?(target: ChatTarget, messageId: string): Promise<void>; }
export interface PublicItem { threadId: string; turnId: string; itemId: string; phase: string; text: string; ordinal?: number; presentationId?: string; }
/** @deprecated Use AgentEvent. */
export type CodexEvent = AgentEvent;
