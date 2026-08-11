export type TranscriptMediaMetadata = {
  type: "image" | "file";
  mimeType?: string;
  name?: string;
  width?: number;
  height?: number;
  size?: number;
};

export type TranscriptArchiveEntry = {
  id: string;
  timestamp: string;
  sessionId: string;
  sessionFile: string;
  role: string;
  text: string;
  /** Historical archives may contain this field; new writes omit it. */
  content?: unknown;
  media?: TranscriptMediaMetadata[];
  toolName?: string;
  toolCallId?: string;
  customType?: string;
  stopReason?: string;
  errorMessage?: string;
  provider?: string;
  model?: string;
  display?: boolean;
  archiveLine?: number;
  archivePath?: string;
};

export type TranscriptResultMessage = {
  id: string;
  role: string;
  timestamp: string;
  line: number;
  text: string;
  toolName?: string;
};

export type TranscriptSessionResult = {
  sourceType: "session";
  id: string;
  name: string;
  score: number;
  path: string;
  sessionId: string;
  sessionFile: string;
  timestamp: string;
  description: string;
  preview: string;
  role: string;
  hitCount?: number;
  messages?: TranscriptResultMessage[];
};

export type ExternalMemoryResultMessage = Record<string, unknown> &
  Partial<TranscriptResultMessage> & {
    role: string;
    line: number;
    text: string;
  };

export type ExternalMemoryResult = Record<string, unknown> & {
  sourceType: "external";
  provider: string;
  id: string;
  name: string;
  score: number;
  timestamp?: string;
  description?: string;
  preview?: string;
  summary?: string;
  path?: string;
  url?: string;
  reference?: string;
  externalId?: string;
  messages?: ExternalMemoryResultMessage[];
};

export type MemorySearchResult = TranscriptSessionResult | ExternalMemoryResult;

export type IndexedTranscriptEntry = {
  rowKey: string;
  archivePath: string;
  sessionKey: string;
  entry: TranscriptArchiveEntry;
  timestampMs: number;
  preview: string;
  lineNumber: number;
};

export type IndexedSessionBucket = {
  sessionKey: string;
  sessionId: string;
  sessionFile: string;
  bestScore: number;
  totalScore: number;
  hitCount: number;
  latestHitTimestampMs: number;
  messages: TranscriptResultMessage[];
  displayEntries: TranscriptArchiveEntry[];
};

export type TranscriptFileState = {
  archivePath: string;
  mtimeMs: number;
  size: number;
};
