import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionFactory,
  ExtensionUIContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import type { RinExtensionCommandResult } from "./rin-frontend-sdk/types.js";

export type { RinExtensionCommandResult };

/** Cross-frontend result channel added by Rin where the active frontend supports it. */
export type RinExtensionUIContext = ExtensionUIContext & {
  rinCommandResult?: (result: RinExtensionCommandResult) => void;
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

export type RinExternalMemoryResult = Record<string, unknown> & {
  sourceType: "external";
  provider: string;
  id: string;
  name: string;
  score: number;
};

export type RinTranscriptArchiveEntry = {
  id: string;
  timestamp: string;
  sessionId: string;
  sessionFile: string;
  role: string;
  text: string;
  content?: unknown;
  [key: string]: unknown;
};

export type RinDaemonMemorySearchRequest = {
  readonly mode: "search" | "recent";
  readonly query: string;
  readonly limit: number;
  readonly params: Record<string, unknown>;
};

export type RinDaemonMemoryProviderContext = {
  readonly cwd: string;
  readonly agentDir: string;
  readonly dataDir: string;
  readonly runtimeRoot: string;
  readonly key: string;
  readonly name: string;
  readonly packageName: string;
  readonly config: Record<string, unknown>;
  readonly logger: RinExtensionLogger;
};

export type RinDaemonMemoryProvider = {
  search?: (
    request: RinDaemonMemorySearchRequest,
    context: RinDaemonMemoryProviderContext,
  ) =>
    | Promise<
        RinExternalMemoryResult[] | { results?: RinExternalMemoryResult[] }
      >
    | RinExternalMemoryResult[]
    | { results?: RinExternalMemoryResult[] };
  listRecent?: (
    request: RinDaemonMemorySearchRequest,
    context: RinDaemonMemoryProviderContext,
  ) =>
    | Promise<
        RinExternalMemoryResult[] | { results?: RinExternalMemoryResult[] }
      >
    | RinExternalMemoryResult[]
    | { results?: RinExternalMemoryResult[] };
  write?: (
    entry: RinTranscriptArchiveEntry,
    context: RinDaemonMemoryProviderContext,
  ) => Promise<void> | void;
};

export type RinChatAdapterProviderInput = {
  app: unknown;
  agentDir?: string;
  dataDir: string;
  runtimeRoot?: string;
  h?: unknown;
  key: string;
  name: string;
  packageName?: string;
  config: Record<string, unknown>;
  logger?: RinExtensionLogger;
};

export type RinChatAdapterProviderResult = void | {
  adapter?: unknown;
  bot?: unknown;
};

export type RinChatAdapterProvider =
  | ((
      input: RinChatAdapterProviderInput,
    ) => RinChatAdapterProviderResult | Promise<RinChatAdapterProviderResult>)
  | {
      createAdapter(
        input: RinChatAdapterProviderInput,
      ): RinChatAdapterProviderResult | Promise<RinChatAdapterProviderResult>;
    };

export type RinBackgroundServiceStop = {
  stop?: () => Promise<void> | void;
};

export type RinBackgroundServiceContext = {
  readonly cwd: string;
  readonly agentDir: string;
  readonly dataDir: string;
  readonly runtimeRoot: string;
  readonly name: string;
  readonly packageName: string;
  readonly config: Record<string, unknown>;
  readonly signal: AbortSignal;
  readonly logger: RinExtensionLogger;
  runAsync(label: string, work: () => Promise<void> | void): void;
};

export type RinBackgroundServiceProvider = {
  start?: (
    context: RinBackgroundServiceContext,
  ) =>
    | Promise<void | RinBackgroundServiceStop>
    | void
    | RinBackgroundServiceStop;
};

export type RinBackgroundServiceFactory = NonNullable<
  RinBackgroundServiceProvider["start"]
>;

/** Registration-only API for an extension module's daemon-scoped export. */
export type RinDaemonExtensionAPI = Omit<
  RinBackgroundServiceContext,
  "signal" | "runAsync"
> & {
  registerBackgroundService(
    provider: RinBackgroundServiceProvider | RinBackgroundServiceFactory,
  ): void;
  registerChatAdapter(
    provider: RinChatAdapterProvider,
    options?: {
      key?: string;
      name?: string;
      config?: Record<string, unknown>;
    },
  ): void;
  registerMemoryProvider(
    provider: RinDaemonMemoryProvider,
    options?: {
      key?: string;
      name?: string;
      config?: Record<string, unknown>;
    },
  ): void;
};

export type RinDaemonExtensionFactory = (
  rin: RinDaemonExtensionAPI,
) => Promise<void> | void;

/** Add Rin types to a session extension without adding a runtime wrapper. */
export function defineRinExtension<T extends RinExtensionFactory>(
  factory: T,
): T {
  return factory;
}

/** Define the explicit daemon-scoped half of a Rin extension package. */
export function defineRinDaemonExtension<T extends RinDaemonExtensionFactory>(
  factory: T,
): T {
  return factory;
}
