import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionFactory,
  ExtensionUIContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import type {
  RinExtensionCommandResult,
  RinMessageCatalog,
} from "./rin-frontend-sdk/types.js";

export type { RinExtensionCommandResult, RinMessageCatalog };

/** Cross-frontend capabilities added by Rin where the active frontend supports them. */
export type RinExtensionUIContext = ExtensionUIContext & {
  rinCommandResult?: (result: RinExtensionCommandResult) => void;
  setMessageCatalog?: (catalog: RinMessageCatalog) => void;
};

export type RinExtensionCommandContext = Omit<ExtensionCommandContext, "ui"> & {
  ui: RinExtensionUIContext;
};

/** Rin metadata layered onto Pi's command definition. */
export type RinCommandOptions = Omit<
  RegisteredCommand,
  "name" | "sourceInfo" | "handler"
> & {
  /** Expose this command to trusted Rin chat callers. */
  chat?: boolean;
  handler: (args: string, ctx: RinExtensionCommandContext) => Promise<void>;
};

/**
 * Pi's extension API with Rin's typed command metadata.
 *
 * This is a structural type overlay, not a second runtime registry. All
 * registrations still flow through Pi's ExtensionRunner.
 */
export type RinExtensionAPI = Omit<ExtensionAPI, "registerCommand"> & {
  registerCommand(name: string, options: RinCommandOptions): void;
};

export type RinExtensionFactory = (
  rin: RinExtensionAPI,
) => ReturnType<ExtensionFactory>;

export type RinRegisteredCommand = RegisteredCommand & {
  chat?: boolean;
};

export type RinExtensionLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type RinChatPlatformBot = {
  platform: string;
  selfId: string;
  status: number;
  sendMessage(
    chatId: string,
    content: unknown,
    options?: Record<string, unknown>,
  ): Promise<string[]> | string[];
  outboxMediaSendTimeoutMs?: number;
  outboxUsesDispatchSignal?: boolean;
  getCompleteMemberProof?(input: {
    chatId: string;
    botId: string;
    senderId: string;
  }): Promise<
    | { complete: false }
    | { complete: true; privateLike: false }
    | { complete: true; nonAgentUserIds: string[] }
  >;
  isChatMember?(chatId: string, userId: string): Promise<boolean>;
  [key: string]: unknown;
};

export type RinChatInboundRecoveryHead = {
  chatKey: string;
  chatId: string;
  messageId: string;
  platformTimestamp: number;
  providerCursor?: string;
  failureCount?: number;
  firstFailedAt?: string;
  lastFailedAt?: string;
  pausedAt?: string;
  nextAttemptAt?: string;
  recoveryVersion?: number;
};

export type RinChatInboundRecoveryResult<T> = {
  recovered: T[];
  failures: string[];
  deferred: string[];
  retired: string[];
  scopeHealthy: boolean;
};

export type RinChatPlatformInput = {
  agentDir: string;
  dataDir: string;
  config: Record<string, unknown>;
  logger: RinExtensionLogger;
  receive(session: unknown): void;
  updateStatus(bot: RinChatPlatformBot, status: number): void;
  composeKey(chatId: string, botId: string): string;
  beginRecovery(chatKey: string): void;
  completeRecovery(chatKey: string): void;
  recoverInbound<T>(
    botId: string,
    recover: (head: RinChatInboundRecoveryHead) => Promise<T[]>,
    options?: {
      concurrency?: number;
      onHeads?: (heads: RinChatInboundRecoveryHead[]) => void | Promise<void>;
      onHeadSettled?: (outcome: {
        head: RinChatInboundRecoveryHead;
        recovered: T[];
        error?: unknown;
      }) => void | Promise<void>;
    },
  ): Promise<RinChatInboundRecoveryResult<T>>;
};

export type RinChatPlatform = {
  readonly bot: RinChatPlatformBot;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  setWorkingText?(text: string): void;
};

export type RinChatPlatformContribution = {
  apiVersion: 1;
  platform: string;
  defaults?: Record<string, unknown>;
  create(
    input: RinChatPlatformInput,
  ): RinChatPlatform | Promise<RinChatPlatform>;
};

export const RIN_CHAT_PLATFORM_EVENT = "rin.chat.platform.v1";

/** Add Rin types to a session extension without adding a runtime wrapper. */
export function defineRinExtension<T extends RinExtensionFactory>(
  factory: T,
): T {
  return factory;
}
