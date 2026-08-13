import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { RinFrontendIdentity } from "../rin-lib/frontend-identity.js";

export type RinHookHandler = (event: any, ctx: any) => Promise<any> | any;

export type RinCapabilityMode = "tui" | "rpc" | "json" | "print";

export type RinCapabilityOptions = {
  readonly cwd: string;
  readonly agentDir: string;
  readonly getThinkingLevel: () => ThinkingLevel;
  readonly sendMessage: (message: any, options?: any) => void;
  readonly emitEvent?: (event: any) => void;
  readonly compactWithPiNative?: (event: any) => Promise<any>;
  readonly selfImproveTurnWindowTurns?: number;
};

export type RinCapabilityDefinition = {
  name?: string;
  tools?: any[];
  hooks?: Record<string, RinHookHandler[]>;
};

export type RinCapabilityContext = {
  ui: any;
  mode: RinCapabilityMode;
  hasUI: boolean;
  cwd: string;
  agentDir: string;
  sessionManager: any;
  modelRegistry: any;
  readonly model: any;
  readonly thinkingLevel: ThinkingLevel;
  readonly frontend?: RinFrontendIdentity;
  isIdle: () => boolean;
  signal: AbortSignal | undefined;
  abort: () => void;
  hasPendingMessages: () => boolean;
  shutdown: () => void;
  getContextUsage: () => any;
  compact: (options?: any) => void;
  getSystemPrompt: () => string;
  getSystemPromptOptions: () => any;
  getThinkingLevel: () => ThinkingLevel;
  emitEvent: (event: any) => void;
};
