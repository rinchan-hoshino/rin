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
  formatCompactionExpandHint,
  formatCompactionSummaryCollapsedLine,
  formatCompactionSummaryCollapsedText,
  formatCompactionSummaryTitle,
  formatCompactionTokenCount,
  type CompactionSummaryCollapsedTextOptions,
} from "./compaction-summary-format.js";

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
  RIN_NON_INTERACTIVE_COMMAND_NAMES,
  RIN_FRONTEND_SESSION_COMMANDS,
  classifyRinFrontendCommand,
  getRinNonInteractiveCommandInteractionPolicy,
  getRinFrontendSessionCommandSpec,
  isFrontendSessionCommandLine,
  isRinNonInteractiveCommandExposed,
  type RinFrontendCommandCatalogItem,
  type RinFrontendCommandRoute,
  type RinFrontendCommandRouteKind,
  type RinNonInteractiveCommandActiveTurnHandling,
  type RinNonInteractiveCommandInteractionPolicy,
  type RinFrontendCommandSpec,
} from "./command-dispatcher.js";

export {
  runFrontendEntrypoint,
  type RinFrontendEntrypointHost,
  type RinFrontendEntrypointStart,
} from "./entrypoint.js";

export {
  TUI_FRONTEND_IDENTITY,
  chatFrontendIdentity,
  normalizeFrontendIdentity,
  sameFrontendIdentity,
  sourceFrontendIdentity,
  type RinFrontendIdentity,
} from "./frontend-identity.js";

export {
  formatPromptContext,
  formatPromptContextSystemPromptBlock,
  injectPromptContextHeader,
  type PromptContextMeta,
} from "./prompt-context.js";

export {
  replayPendingTerminalTurnEvent,
  type RinPendingTerminalTurnEventCommand,
  type RinPendingTerminalTurnEventRequester,
} from "./pending-terminal-turn.js";

export {
  handleRinRpcSessionEvent,
  type RinRpcSessionEventRefresh,
  type RinRpcSessionEventTarget,
} from "./rpc-session-events.js";

export {
  RinFrontendTurnDriver,
  submitNativeFrontendPromptTurn,
  type RinFrontendPromptTurnInput,
  type RinFrontendTurnClient,
  type RinFrontendTurnDriverEvent,
  type RinFrontendTurnPhase,
  type RinFrontendTurnResult,
} from "./turn-driver.js";

export {
  areRinTurnTerminalOutcomesConsistent,
  classifyRinTurnMessage,
  isRinTerminalAssistantMessage,
  RIN_TURN_TERMINAL_ABSENT,
  RinTurnSettlementProjector,
  resolveRinAuthoritativeTurnTerminalOutcome,
  resolveRinTurnCompletionFromAssistantMessage,
  resolveRinTurnCompletionFromTurnResult,
  resolveRinTurnFailureMessage,
  resolveRinSettledTurnTerminalOutcomeFromMessages,
  resolveRinTurnTerminalOutcomeFromAssistantMessage,
  resolveRinTurnTerminalOutcomeFromMessages,
  resolveRinTurnTerminalOutcomeFromTurnResult,
  type RinTurnCompletionResolution,
  type RinTurnTerminalOutcome,
} from "./turn-completion.js";

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
