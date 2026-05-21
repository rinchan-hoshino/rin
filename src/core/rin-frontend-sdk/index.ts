export type {
  RinExtensionUiMethod,
  RinExtensionUiRequest,
  RinExtensionUiResponse,
  RinFrontendAutocompleteItem,
  RinFrontendClient,
  RinFrontendCommandItem,
  RinFrontendEvent,
  RinFrontendBackendEvent,
  RinFrontendModelItem,
  RinFrontendSessionItem,
  RinFrontendStatusPhase,
  RinNewSessionOptions,
  RinNewSessionResult,
  RinPromptContext,
  RinPromptOptions,
  RinRpcCommand,
  RinRpcResponse,
  RinSessionState,
} from "./types.js";

export {
  createRinFrontendBackendEventTranslator,
  type RinFrontendBackendEventTranslator,
} from "./backend-events.js";

export {
  DEFAULT_RIN_FRONTEND_COMMAND_RESPONSES,
  applyFrontendBuiltinCommandText,
  frontendCommandNameFromLine,
  isFrontendAbortCommand,
  isFrontendNewSessionCommand,
  parseFrontendCompactCommand,
  resolveRinFrontendCommandResponses,
  type RinFrontendCommandResponses,
} from "./command-responses.js";

export {
  RinFrontendTurnDriver,
  flushPendingSelfImproveNotices,
  submitNativeFrontendPromptTurn,
  type RinFrontendPromptTurnInput,
  type RinFrontendTurnClient,
  type RinFrontendTurnDriverEvent,
  type RinFrontendTurnPhase,
  type RinFrontendTurnResult,
} from "./turn-driver.js";

export {
  RinDaemonFrontendClient,
  type RinDaemonFrontendClientTransportOptions,
} from "./daemon-client.js";

export { createAuthStorageProxy } from "./rpc-auth.js";

export { createModelRegistry } from "./model-registry.js";

export {
  cycleRpcModel,
  cycleRpcThinkingLevel,
  getPersistentSettingsManager,
  persistRpcSettingsMutation,
  setRpcAutoCompaction,
  setRpcFollowUpMode,
  setRpcModel,
  setRpcSteeringMode,
  setRpcThinkingLevel,
} from "./model-settings.js";

export {
  calculateContextTokens,
  computeAvailableThinkingLevels,
  estimateContextTokens,
  estimateMessageTokens,
  extractText,
  getLastAssistantText,
} from "./session-helpers.js";

export { computeSessionStats, getContextUsage } from "./stats.js";

export {
  applyRpcMessages,
  applyRpcSessionState,
  applyRpcSessionTree,
  getSessionBranch,
} from "./state-utils.js";

export type {
  FrontendAutocompleteItem,
  FrontendCommandItem,
  FrontendDialogSpec,
  FrontendExtensionErrorEvent,
  FrontendExtensionUiRequestEvent,
  FrontendMessageDeltaEvent,
  FrontendMessageDoneEvent,
  FrontendModelItem,
  FrontendSessionChangedEvent,
  FrontendSessionItem,
  FrontendStatusEvent,
  FrontendToolEvent,
  FrontendUiEvent,
  InteractiveFrontendEvent,
  InteractiveFrontendSurface,
  RpcFrontendClient,
} from "./frontend-surface.js";

export {
  FRONTEND_SDK_RUNTIME_WRAPPER_KEY,
  FRONTEND_SDK_SESSION_WRAPPER_KEY,
  createFrontendSdkRuntimeWrapper,
  createFrontendSdkSessionWrapper,
  isFrontendSdkRuntimeWrapper,
  isFrontendSdkSessionWrapper,
} from "./runtime-wrapper.js";

export type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionFactory,
  ExtensionUIContext,
  ProviderConfig,
  ProviderModelConfig,
  RegisteredCommand,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
