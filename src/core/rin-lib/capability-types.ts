import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type RinHookHandler = (event: any, ctx: any) => Promise<any> | any;

export type RinCapabilityOptions = {
  readonly cwd: string;
  readonly agentDir: string;
  readonly getThinkingLevel: () => ThinkingLevel;
  readonly sendMessage: (message: any, options?: any) => void;
};

export type RinCapabilityDefinition = {
  name?: string;
  tools?: any[];
  hooks?: Record<string, RinHookHandler[]>;
};

export type RinCapabilityContext = {
  ui: any;
  hasUI: boolean;
  cwd: string;
  agentDir: string;
  sessionManager: any;
  modelRegistry: any;
  readonly model: any;
  isIdle: () => boolean;
  signal: AbortSignal | undefined;
  abort: () => void;
  hasPendingMessages: () => boolean;
  shutdown: () => void;
  getContextUsage: () => any;
  compact: (options?: any) => void;
  getSystemPrompt: () => string;
  getThinkingLevel: () => ThinkingLevel;
};
