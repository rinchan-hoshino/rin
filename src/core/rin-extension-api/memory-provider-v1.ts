export const RIN_MEMORY_PROVIDER_API_VERSION = 1 as const;

export const RIN_MEMORY_PROVIDER_TIMEOUTS_V1 = Object.freeze({
  searchMs: 30_000,
  writeMs: 5_000,
});

export type RinMemoryProviderApiVersion =
  typeof RIN_MEMORY_PROVIDER_API_VERSION;

export interface RinMemoryProviderLoggerV1 {
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

export interface RinMemoryProviderContextV1 {
  readonly apiVersion: 1;
  readonly key: string;
  readonly name: string;
  readonly packageName: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  readonly logger: RinMemoryProviderLoggerV1;
}

export interface RinMemorySearchRequestV1 {
  readonly apiVersion: 1;
  readonly mode: "search";
  readonly query: string;
  readonly limit: number;
  readonly order: "relevance" | "newest";
}

export interface RinMemoryRecentRequestV1 {
  readonly apiVersion: 1;
  readonly mode: "recent";
  readonly query: "";
  readonly limit: number;
  readonly order: "newest";
}

export type RinMemoryReadRequestV1 =
  | RinMemorySearchRequestV1
  | RinMemoryRecentRequestV1;

export interface RinMemoryResultMessageV1 {
  readonly id?: string;
  readonly role?: string;
  readonly timestamp?: string;
  readonly line?: number;
  readonly text: string;
  readonly toolName?: string;
}

export interface RinMemoryResultV1 {
  readonly id: string;
  readonly name?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly preview?: string;
  readonly score?: number;
  readonly timestamp?: string;
  readonly url?: string;
  readonly reference?: string;
  readonly externalId?: string;
  readonly messages?: readonly RinMemoryResultMessageV1[];
}

export interface RinMemoryWriteMetadataV1 {
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly customType?: string;
  readonly provider?: string;
  readonly model?: string;
}

export interface RinMemoryWriteRecordV1 {
  readonly apiVersion: 1;
  readonly id: string;
  readonly timestamp: string;
  readonly scope: Readonly<{ sessionId: string }>;
  readonly role: string;
  readonly text: string;
  readonly metadata?: RinMemoryWriteMetadataV1;
}

export interface RinMemoryProviderV1 {
  search?(
    request: RinMemorySearchRequestV1,
    context: RinMemoryProviderContextV1,
  ): Promise<readonly RinMemoryResultV1[]> | readonly RinMemoryResultV1[];
  listRecent?(
    request: RinMemoryRecentRequestV1,
    context: RinMemoryProviderContextV1,
  ): Promise<readonly RinMemoryResultV1[]> | readonly RinMemoryResultV1[];
  write?(
    record: RinMemoryWriteRecordV1,
    context: RinMemoryProviderContextV1,
  ): Promise<void> | void;
}

export type RinMemoryProviderModeV1 = "append" | "replace";

export interface RinMemoryProviderRegistrationOptionsV1 {
  readonly apiVersion: 1;
  readonly mode?: RinMemoryProviderModeV1;
  readonly key?: string;
  readonly name?: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface RinMemoryProviderExtensionApiV1 {
  registerMemoryProvider(
    provider: RinMemoryProviderV1,
    options: RinMemoryProviderRegistrationOptionsV1,
  ): void;
}
