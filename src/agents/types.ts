import type {FileAttachment} from '../chat/types.js';

export interface AgentInput {
  text: string;
  files: FileAttachment[];
  onClientMessageId?(id: string): void;
}

export interface AgentReceipt {
  transport: string;
  turnId?: string;
  messageId?: string;
}

export interface AgentEvent {
  threadId: string;
  turnId: string;
  type: string;
  error?: unknown;
  delta?: string;
  done?: boolean;
  itemId?: string;
  phase?: string;
  text?: string;
  path?: string;
  ordinal?: number;
  clientMessageId?: string;
}

export interface AgentBridge {
  onEvent?: (event: AgentEvent) => void;
  getCursor?: (key: string) => unknown;
  setCursor?: (key: string, value: unknown) => void;
  start(): Promise<void>;
  stop(): Promise<void>;
  queue(threadId: string, input: AgentInput): Promise<AgentReceipt>;
  watch?(threadId: string): unknown | Promise<unknown>;
  createThread?(options: {cwd: string; model?: string; name?: string}): Promise<string>;
  attachmentRoots?(threadId: string): string[];
}

export interface CodexAgentConfig {
  type: 'codex';
  queueTimeoutMs?: number;
  endpoint?: string;
  command?: string[];
  codexHome?: string;
  pollMs?: number;
}

export interface CliAgentConfig {
  type: 'claude-code' | 'pi' | 'opencode';
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  extraArgs?: string[];
}

export type AgentConfig = CodexAgentConfig | CliAgentConfig;
