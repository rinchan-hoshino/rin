import {
  CustomMessageComponent,
  DynamicBorder,
  FooterComponent,
  InteractiveMode,
  keyHint,
  keyText,
  rawKeyHint,
  SessionManager,
  SessionSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import { APP_NAME } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/config.js";
import { formatKeyText } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/keybinding-hints.js";
import { getToolPath } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js";
import {
  Loader,
  Markdown,
  ProcessTerminal,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import {
  listBuiltInRinExtensionStates,
  setBuiltInRinExtensionState,
} from "../rin-builtin-extension-controls.js";

import {
  onThemeChange,
  theme,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

import { sleep } from "../platform/process.js";
import {
  checkForRinUpdateNotice,
  getCurrentRinVersion,
  getNewRinChangelogEntries,
  getRinChangelogUrl,
  parsePackageVersion,
  readRinChangelogEntries,
  type RinUpdateNotice,
} from "../rin-lib/update-notices.js";
import { extractMessageText } from "../message-content.js";
import { formatSelfImproveReviewNotice } from "../rin-frontend-sdk/command-responses.js";
import { shouldPullSelfImproveNoticesForTurnState } from "../rin-frontend-sdk/turn-driver.js";
import { listBoundSessions, renameBoundSession } from "../session/factory.js";
import {
  getRinTuiRuntimeRole,
  RIN_TUI_MAINTENANCE_ROLE,
  RIN_TUI_RPC_FRONTEND_ROLE,
} from "../tui-runtime-env.js";

let applied = false;
const ANSI_DIM = "\u001b[2m";
const ANSI_RESET = "\u001b[0m";
const CLEAR_SCROLLBACK_SEQUENCE = "\u001b[3J";
const PRESERVE_SCROLLBACK_PATCH = Symbol.for(
  "rin.tui.preserve_scrollback_full_redraw",
);
const LOCAL_USER_ECHO_QUEUE_KEY = "__rinLocalUserEchoQueue";
const STARTUP_INPUT_QUEUE_KEY = "__rinStartupInputQueue";
const RPC_TRANSPORT_STATUS_COMPONENT_KEY = "__rinRpcTransportStatusComponent";
const RPC_TRANSPORT_STATUS_MESSAGE_KEY = "__rinRpcTransportStatusMessage";
const RIN_UPDATE_NOTICE_KEY = "__rinUpdateNotice";
const RIN_UPDATE_NOTIFICATION_COMPONENT_KEY =
  "__rinUpdateNotificationComponent";
const RPC_TRANSPORT_STATUS_PHASES = new Set([
  "starting",
  "connecting",
  "sending",
  "compacting",
]);
const TODO_TOOL_COALESCE_EVENTS = new Set(["tool_execution_end", "agent_end"]);

class RinStartupExpandableText extends Text {
  constructor(
    private getCollapsedText: () => string,
    private getExpandedText: () => string,
    expanded = false,
    paddingX = 0,
    paddingY = 0,
  ) {
    super(
      expanded ? getExpandedText() : getCollapsedText(),
      paddingX,
      paddingY,
    );
  }

  setExpanded(expanded: boolean) {
    this.setText(expanded ? this.getExpandedText() : this.getCollapsedText());
  }
}

function dim(text: string) {
  return `${ANSI_DIM}${text}${ANSI_RESET}`;
}

function currentRuntimeModeLabel() {
  const role = getRinTuiRuntimeRole();
  if (role === RIN_TUI_RPC_FRONTEND_ROLE) return "daemon";
  if (role === RIN_TUI_MAINTENANCE_ROLE) return "maint";
  return undefined;
}

function appendRuntimeModeToThinkingLevel(
  thinkingLevel: unknown,
  label: string,
) {
  const value = String(thinkingLevel || "off").trim() || "off";
  return value === "off" ? `thinking off • ${label}` : `${value} • ${label}`;
}

function renderWithRuntimeModeModelLabel(
  footer: any,
  render: (width: number) => unknown,
  width: number,
) {
  const label = currentRuntimeModeLabel();
  const state = footer?.session?.state;
  const model = state?.model;
  if (!label || !model || typeof model.id !== "string") {
    return render.call(footer, width);
  }

  const originalModel = state.model;
  const originalThinkingLevel = state.thinkingLevel;
  if (model.reasoning) {
    state.thinkingLevel = appendRuntimeModeToThinkingLevel(
      state.thinkingLevel,
      label,
    );
  } else {
    state.model = { ...model, id: `${model.id} ${label}` };
  }

  try {
    return render.call(footer, width);
  } finally {
    state.model = originalModel;
    state.thinkingLevel = originalThinkingLevel;
  }
}

function extractUserTextFromEvent(event: any) {
  const message = event?.message;
  if (!message || message.role !== "user") return "";
  return extractMessageText(message.content, { trim: true });
}

function isRpcTransportControlled(instance: any) {
  return typeof instance?.session?.getFrontendStatusEvent === "function";
}

function statusContainerHasChild(instance: any, child: any) {
  if (!child) return false;
  const container = instance?.statusContainer;
  if (Array.isArray(container?.children))
    return container.children.includes(child);
  return container?.child === child;
}

function stopRpcTransportStatusComponent(instance: any) {
  const component = instance?.[RPC_TRANSPORT_STATUS_COMPONENT_KEY];
  if (!component) return false;
  component.stop?.();
  const wasAttached = statusContainerHasChild(instance, component);
  if (wasAttached) {
    instance.statusContainer.clear();
  }
  instance[RPC_TRANSPORT_STATUS_COMPONENT_KEY] = undefined;
  instance[RPC_TRANSPORT_STATUS_MESSAGE_KEY] = undefined;
  return wasAttached;
}

function createRpcTransportStatusLoader(instance: any, message: string) {
  const loader =
    typeof instance?.createWorkingLoader === "function"
      ? instance.createWorkingLoader()
      : new Loader(instance.ui, (text: string) => text, dim, message);
  loader.setMessage?.(message);
  return loader;
}

function formatRpcTransportStatusLabel(label: string) {
  return `${label}...`;
}

function showRpcTransportStatus(instance: any, event: any) {
  const phase = String(event?.phase || "");
  if (!RPC_TRANSPORT_STATUS_PHASES.has(phase)) {
    const changed = stopRpcTransportStatusComponent(instance);
    if (changed) instance?.ui?.requestRender?.();
    return;
  }

  const label = String(event?.label || phase || "Starting");
  const message = formatRpcTransportStatusLabel(label);
  let component = instance?.[RPC_TRANSPORT_STATUS_COMPONENT_KEY];
  const attached = statusContainerHasChild(instance, component);
  const previousMessage = instance?.[RPC_TRANSPORT_STATUS_MESSAGE_KEY];
  if (component && attached && previousMessage === message) {
    return;
  }

  let renderedByLoader = false;
  if (!component) {
    component = createRpcTransportStatusLoader(instance, message);
    instance[RPC_TRANSPORT_STATUS_COMPONENT_KEY] = component;
    renderedByLoader = true;
  } else if (previousMessage !== message) {
    component.setMessage?.(message);
    renderedByLoader = true;
  }
  instance[RPC_TRANSPORT_STATUS_MESSAGE_KEY] = message;

  if (!attached) {
    instance.statusContainer.clear();
    instance.statusContainer.addChild(component);
    if (!renderedByLoader) instance.ui.requestRender();
  }
}

function reattachExistingPiLoader(instance: any) {
  const clearedTransportStatus = stopRpcTransportStatusComponent(instance);
  if (!instance?.loadingAnimation) {
    if (clearedTransportStatus) instance?.ui?.requestRender?.();
    return;
  }
  if (!statusContainerHasChild(instance, instance.loadingAnimation)) {
    instance.statusContainer.clear();
    instance.statusContainer.addChild(instance.loadingAnimation);
  }
  instance.ui.requestRender();
}

function syncRpcFrontendStatus(instance: any, statusOverride?: any) {
  if (!isRpcTransportControlled(instance)) return;
  const status = statusOverride ?? instance.session.getFrontendStatusEvent?.();
  const phase = String(status?.phase || "");
  if (phase === "working") {
    reattachExistingPiLoader(instance);
    return;
  }
  if (phase === "compacting" && instance?.autoCompactionLoader) {
    stopRpcTransportStatusComponent(instance);
    if (!statusContainerHasChild(instance, instance.autoCompactionLoader)) {
      instance.statusContainer.clear();
      instance.statusContainer.addChild(instance.autoCompactionLoader);
    }
    instance.ui.requestRender();
    return;
  }
  if (RPC_TRANSPORT_STATUS_PHASES.has(phase)) {
    showRpcTransportStatus(instance, status);
    return;
  }
  const changed = stopRpcTransportStatusComponent(instance);
  if (changed || phase === "idle") instance?.ui?.requestRender?.();
}

function syncLocalPiLoader(instance: any) {
  if (isRpcTransportControlled(instance)) return;
  if (!instance?.session?.isStreaming) return;
  reattachExistingPiLoader(instance);
}

function shouldReapplyLocalPiLoaderAfterEvent(instance: any, event: any) {
  return (
    !isRpcTransportControlled(instance) && event?.type === "compaction_end"
  );
}

function getLocalUserEchoQueue(instance: any) {
  const queue = instance[LOCAL_USER_ECHO_QUEUE_KEY];
  if (Array.isArray(queue)) return queue;
  const nextQueue: string[] = [];
  instance[LOCAL_USER_ECHO_QUEUE_KEY] = nextQueue;
  return nextQueue;
}

function resetLocalUserEchoQueue(instance: any) {
  instance[LOCAL_USER_ECHO_QUEUE_KEY] = [];
}

function getStartupInputQueue(instance: any) {
  const queue = instance[STARTUP_INPUT_QUEUE_KEY];
  if (Array.isArray(queue)) return queue;
  const nextQueue: string[] = [];
  instance[STARTUP_INPUT_QUEUE_KEY] = nextQueue;
  return nextQueue;
}

function shouldBufferStartupInput(instance: any, text: string) {
  if (!isRpcTransportControlled(instance)) return false;
  if (instance?.onInputCallback) return false;
  if (instance?.session?.isStreaming || instance?.session?.isCompacting) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/") || trimmed.startsWith("!")) return false;
  return true;
}

function shouldSuppressLocalUserEcho(instance: any, event: any) {
  if (event?.type !== "message_start") return false;
  const nextText = extractUserTextFromEvent(event);
  if (!nextText) return false;
  const queue = getLocalUserEchoQueue(instance);
  if (queue[0] !== nextText) return false;
  queue.shift();
  return true;
}

function shouldIgnoreInteractiveSigint(instance: any) {
  return instance?.ui?.stopped === true;
}

function stripClearScrollback(data: string) {
  return data.includes(CLEAR_SCROLLBACK_SEQUENCE)
    ? data.split(CLEAR_SCROLLBACK_SEQUENCE).join("")
    : data;
}

function isTodoToolComponent(component: any) {
  return String(component?.toolName || "") === "todo";
}

function isTodoOnlyAssistantComponent(component: any) {
  const message = component?.lastMessage;
  if (!message || message.role !== "assistant") return false;
  const content = Array.isArray(message.content) ? message.content : [];
  return (
    content.length > 0 &&
    content.every(
      (part: any) =>
        part?.type === "toolCall" && String(part?.name || "") === "todo",
    )
  );
}

function setTodoToolComponentHidden(component: any, hidden: boolean) {
  if (!isTodoToolComponent(component)) return false;
  if (component.hideComponent === hidden) return false;
  component.invalidate?.();
  component.hideComponent = hidden;
  return true;
}

export function coalesceTodoToolComponentsInContainer(container: any) {
  const children = Array.isArray(container?.children) ? container.children : [];
  let changed = 0;
  let run: any[] = [];

  const flush = () => {
    const todoComponents = run.filter(isTodoToolComponent);
    if (todoComponents.length > 0) {
      const last = todoComponents[todoComponents.length - 1];
      for (const component of todoComponents) {
        if (setTodoToolComponentHidden(component, component !== last)) {
          changed += 1;
        }
      }
    }
    run = [];
  };

  for (const child of children) {
    if (isTodoToolComponent(child) || isTodoOnlyAssistantComponent(child)) {
      run.push(child);
    } else {
      flush();
    }
  }
  flush();

  return changed;
}

function shouldCoalesceTodoAfterEvent(event: any) {
  return TODO_TOOL_COALESCE_EVENTS.has(String(event?.type || ""));
}

function clearCurrentSessionRenderState(instance: any) {
  instance.chatContainer?.clear?.();
  instance.pendingMessagesContainer?.clear?.();
  instance.compactionQueuedMessages = [];
  instance.streamingComponent = undefined;
  instance.streamingMessage = undefined;
  instance.pendingTools?.clear?.();
}

function currentSessionHasRenderedHistory(instance: any) {
  const messages =
    instance?.session?.messages ?? instance?.session?.state?.messages;
  if (Array.isArray(messages) && messages.length > 0) return true;
  const entries = instance?.sessionManager?.getEntries?.();
  return Array.isArray(entries) && entries.length > 0;
}

export function renderRinInitialSessionChrome(instance: any) {
  instance.showLoadedResources?.({
    force: false,
    showDiagnosticsWhenQuiet: true,
  });
  instance.showStartupNoticesIfNeeded?.();
  restoreRinUpdateNotificationAfterSessionRedraw(instance);
}

export function renderRinCurrentSessionStateAfterReplacement(instance: any) {
  clearCurrentSessionRenderState(instance);
  if (!currentSessionHasRenderedHistory(instance)) {
    renderRinInitialSessionChrome(instance);
  }
  instance.renderInitialMessages?.();
  restoreRinUpdateNotificationAfterSessionRedraw(instance);
}

async function withoutRebindChatDecorations(
  instance: any,
  operation: () => Promise<unknown>,
) {
  const originalShowLoadedResources = instance.showLoadedResources;
  const originalShowStartupNoticesIfNeeded =
    instance.showStartupNoticesIfNeeded;
  instance.showLoadedResources = () => {};
  instance.showStartupNoticesIfNeeded = () => {};
  try {
    return await operation();
  } finally {
    instance.showLoadedResources = originalShowLoadedResources;
    instance.showStartupNoticesIfNeeded = originalShowStartupNoticesIfNeeded;
  }
}

function redrawCurrentSessionHistoryAfterRpcResync(instance: any) {
  clearCurrentSessionRenderState(instance);
  const context = instance.sessionManager.buildSessionContext();
  instance.renderSessionContext(context, {
    updateFooter: true,
    populateHistory: true,
  });
}

function formatRinUpdateNotificationText(notice: RinUpdateNotice) {
  const channelPrefix = notice.channel === "stable" ? "" : `${notice.channel} `;
  return [
    `Rin ${channelPrefix}update available: ${notice.version}`,
    `Run: ${notice.command}`,
    `Changelog: ${getRinChangelogUrl()}`,
  ].join("\n");
}

function formatRinUpdateWarningText(text: string) {
  return theme.fg("warning", `Warning: ${text}`);
}

export class DeferredRinUpdateNotification {
  private readonly spacer = new Spacer(1);
  private readonly text = new Text("", 1, 0);
  private active = false;

  setText(text: string) {
    this.active = true;
    this.text.setText(text);
  }

  invalidate() {
    this.spacer.invalidate?.();
    this.text.invalidate?.();
  }

  render(width: number) {
    if (!this.active) return [];
    return [...this.spacer.render(width), ...this.text.render(width)];
  }
}

function containerHasChild(container: any, child: any) {
  return Boolean(
    child &&
    Array.isArray(container?.children) &&
    container.children.includes(child),
  );
}

export function insertRinUpdateNotificationPlaceholder(instance: any) {
  const placeholder = new DeferredRinUpdateNotification();
  instance[RIN_UPDATE_NOTIFICATION_COMPONENT_KEY] = placeholder;
  instance.chatContainer.addChild(placeholder);
  return placeholder;
}

function ensureRinUpdateNotificationPlaceholder(
  instance: any,
  placeholder?: DeferredRinUpdateNotification,
) {
  if (containerHasChild(instance?.chatContainer, placeholder)) {
    return placeholder;
  }
  const current = instance?.[RIN_UPDATE_NOTIFICATION_COMPONENT_KEY];
  if (containerHasChild(instance?.chatContainer, current)) {
    return current;
  }
  return insertRinUpdateNotificationPlaceholder(instance);
}

function selfImproveNoticeTurnState(instance: any) {
  const status = instance?.session?.getFrontendStatusEvent?.();
  return {
    liveTurn: status?.phase === "working",
    isStreaming: Boolean(instance?.session?.isStreaming || status?.isStreaming),
    turnActive: Boolean(status?.turnActive),
  };
}

export function shouldPullSelfImproveReviewNotices(instance: any) {
  return shouldPullSelfImproveNoticesForTurnState(
    selfImproveNoticeTurnState(instance),
  );
}

export function showSelfImproveReviewNotice(instance: any, event: any) {
  const text = formatSelfImproveReviewNotice(event);
  if (!text) return false;
  if (typeof instance?.chatContainer?.addChild !== "function") return false;
  const component = new CustomMessageComponent(
    {
      role: "custom",
      customType: "self-improve",
      content: text,
      display: true,
      details: event,
      timestamp: Date.now(),
    },
    undefined,
    instance.getMarkdownThemeWithSettings?.(),
  );
  instance.chatContainer.addChild(component);
  instance.footer?.invalidate?.();
  instance.ui?.requestRender?.();
  return true;
}

export function showRinUpdateNotification(
  instance: any,
  notice: RinUpdateNotice,
  placeholder?: DeferredRinUpdateNotification,
) {
  instance[RIN_UPDATE_NOTICE_KEY] = notice;
  const target = ensureRinUpdateNotificationPlaceholder(instance, placeholder);
  const text = formatRinUpdateNotificationText(notice);
  target.setText(formatRinUpdateWarningText(text));
  instance?.ui?.requestRender?.();
}

export function restoreRinUpdateNotificationAfterSessionRedraw(instance: any) {
  const notice = instance?.[RIN_UPDATE_NOTICE_KEY];
  if (!notice) return false;
  showRinUpdateNotification(instance, notice);
  return true;
}

function scheduleRinUpdateNotificationWhenReady(instance: any) {
  const placeholder = insertRinUpdateNotificationPlaceholder(instance);
  void sleep(0).then(() =>
    showRinUpdateNotificationWhenReady(instance, placeholder),
  );
}

async function showRinUpdateNotificationWhenReady(
  instance: any,
  placeholder: DeferredRinUpdateNotification,
) {
  try {
    const notice = await checkForRinUpdateNotice();
    if (!notice) return;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (instance?.isInitialized) break;
      await sleep(50);
    }
    showRinUpdateNotification(instance, notice, placeholder);
  } catch {
    // Update checks must never block the TUI.
  }
}

function getRinStartupChangelogForDisplay(instance: any) {
  if ((instance?.session?.state?.messages || []).length > 0) {
    return undefined;
  }

  const currentVersion = getCurrentRinVersion();
  if (!parsePackageVersion(currentVersion)) return undefined;

  const settingsManager = instance?.settingsManager;
  const lastVersion = settingsManager?.getLastChangelogVersion?.();
  if (!parsePackageVersion(lastVersion)) {
    settingsManager?.setLastChangelogVersion?.(currentVersion);
    return undefined;
  }

  const entries = getNewRinChangelogEntries(
    readRinChangelogEntries(),
    lastVersion,
    currentVersion,
  );
  if (entries.length > 0) {
    settingsManager?.setLastChangelogVersion?.(currentVersion);
    return entries.map((entry) => entry.content).join("\n\n");
  }
  return undefined;
}

function renderRinChangelog(instance: any) {
  const entries = readRinChangelogEntries();
  const changelogMarkdown =
    entries.length > 0
      ? entries
          .slice()
          .reverse()
          .map((entry) => entry.content)
          .join("\n\n")
      : "No changelog entries found.";

  instance.chatContainer.addChild(new Spacer(1));
  instance.chatContainer.addChild(new DynamicBorder());
  instance.chatContainer.addChild(new Text("What's New", 1, 0));
  instance.chatContainer.addChild(new Spacer(1));
  instance.chatContainer.addChild(
    new Markdown(
      changelogMarkdown,
      1,
      1,
      instance.getMarkdownThemeWithSettings?.(),
    ),
  );
  instance.chatContainer.addChild(new DynamicBorder());
  instance.ui.requestRender();
}

async function renameSessionIfNamed(
  rename: (sessionFilePath: string, nextName: string) => Promise<void> | void,
  sessionFilePath: string,
  nextName: string | undefined,
) {
  const next = (nextName ?? "").trim();
  if (!next) return;
  await rename(sessionFilePath, next);
}

function preserveScrollbackOnFullRedraw() {
  const processTerminalProto: any = ProcessTerminal?.prototype as any;
  if (
    !processTerminalProto ||
    processTerminalProto[PRESERVE_SCROLLBACK_PATCH]
  ) {
    return;
  }

  const originalWrite = processTerminalProto.write;
  if (typeof originalWrite !== "function") return;

  Object.defineProperty(processTerminalProto, PRESERVE_SCROLLBACK_PATCH, {
    value: true,
  });
  processTerminalProto.write = function writePreservingScrollback(
    data: unknown,
  ) {
    const nextData =
      typeof data === "string" ? stripClearScrollback(data) : data;
    return originalWrite.call(this, nextData);
  };
}

function renderRinSessionSelectorHeader(header: any, width: number) {
  const title = "Resume Session";
  const leftText = theme.bold(title);
  const sortLabel =
    header.sortMode === "threaded"
      ? "Threaded"
      : header.sortMode === "recent"
        ? "Recent"
        : "Fuzzy";
  const sortText = theme.fg("muted", "Sort: ") + theme.fg("accent", sortLabel);
  const nameLabel = header.nameFilter === "all" ? "All" : "Named";
  const nameText = theme.fg("muted", "Name: ") + theme.fg("accent", nameLabel);
  let scopeText;
  if (header.loading) {
    const progressText = header.loadProgress
      ? `${header.loadProgress.loaded}/${header.loadProgress.total}`
      : "...";
    scopeText = `${theme.fg("muted", "○ Sessions | ")}${theme.fg("accent", `Loading ${progressText}`)}`;
  } else if (header.scope === "current") {
    scopeText = `${theme.fg("accent", "◉ Sessions")}${theme.fg("muted", " | ○ All")}`;
  } else {
    scopeText = `${theme.fg("muted", "○ Sessions | ")}${theme.fg("accent", "◉ All")}`;
  }
  const rightText = truncateToWidth(
    `${scopeText}  ${nameText}  ${sortText}`,
    width,
    "",
  );
  const availableLeft = Math.max(0, width - visibleWidth(rightText) - 1);
  const left = truncateToWidth(leftText, availableLeft, "");
  const spacing = Math.max(
    0,
    width - visibleWidth(left) - visibleWidth(rightText),
  );

  let hintLine1;
  let hintLine2;
  if (header.confirmingDeletePath !== null) {
    const confirmHint = `Delete session? ${keyHint("tui.select.confirm", "confirm")} · ${keyHint("tui.select.cancel", "cancel")}`;
    hintLine1 = theme.fg("error", truncateToWidth(confirmHint, width, "…"));
    hintLine2 = "";
  } else if (header.statusMessage) {
    const color = header.statusMessage.type === "error" ? "error" : "accent";
    hintLine1 = theme.fg(
      color,
      truncateToWidth(header.statusMessage.message, width, "…"),
    );
    hintLine2 = "";
  } else {
    const pathState = header.showPath ? "(on)" : "(off)";
    const sep = theme.fg("muted", " · ");
    const hint1 =
      keyHint("tui.input.tab", "scope") +
      sep +
      theme.fg("muted", 're:<pattern> regex · "phrase" exact');
    const hint2Parts = [
      keyHint("app.session.toggleSort", "sort"),
      keyHint("app.session.toggleNamedFilter", "named"),
      keyHint("app.session.delete", "delete"),
      keyHint("app.session.togglePath", `path ${pathState}`),
    ];
    if (header.showRenameHint) {
      hint2Parts.push(keyHint("app.session.rename", "rename"));
    }
    const hint2 = hint2Parts.join(sep);
    hintLine1 = truncateToWidth(hint1, width, "…");
    hintLine2 = truncateToWidth(hint2, width, "…");
  }
  return [`${left}${" ".repeat(spacing)}${rightText}`, hintLine1, hintLine2];
}

function configureRootSessionSelectorPresentation(selector: any) {
  if (!selector || typeof selector !== "object") return;

  if (selector.header && typeof selector.header.render === "function") {
    selector.header.render = function renderWithRinSessionSelectorHeader(
      width: number,
    ) {
      return renderRinSessionSelectorHeader(this, width);
    };
  }

  const sessionList = selector.sessionList;
  if (sessionList && typeof sessionList.setSessions === "function") {
    const originalSetSessions = sessionList.setSessions.bind(sessionList);
    sessionList.setSessions = (sessions: unknown, _showCwd?: boolean) => {
      originalSetSessions(sessions, true);
    };
    sessionList.showCwd = true;
  }
}

function formatRinStartupVersionLabel(version = getCurrentRinVersion()) {
  const trimmed = String(version || "unknown").trim() || "unknown";
  if (/^v\d+\.\d+\.\d+(?:[-+].*)?$/i.test(trimmed)) return trimmed;
  if (/^\d+\.\d+\.\d+(?:[-+].*)?$/i.test(trimmed)) return `v${trimmed}`;
  return trimmed;
}

export function rewriteRinStartupHeaderText(
  text: string,
  upstreamVersion?: string,
  rinVersion = getCurrentRinVersion(),
) {
  let next = String(text || "")
    .replace(
      /\bPi can explain its own features and look up its docs\./g,
      "Rin can explain its own features and look up its docs.",
    )
    .replace(
      /\bAsk it how to use or extend Pi\./g,
      "Ask Rin how to use or extend Rin.",
    )
    .split("pi")
    .join("rin")
    .split("Pi")
    .join("Rin");
  const upstreamVersionText = String(upstreamVersion || "").trim();
  if (upstreamVersionText) {
    next = next
      .split(`v${upstreamVersionText}`)
      .join(formatRinStartupVersionLabel(rinVersion));
  } else {
    next = next.replace(
      /\brin\s+v[0-9A-Za-z.+-]+/i,
      `Rin ${formatRinStartupVersionLabel(rinVersion)}`,
    );
  }
  return next
    .replace(
      /\bRin can explain (?:its|h(?:er)) own features and look up (?:its|h(?:er)) docs\./g,
      "Rin can explain its own features and look up its docs.",
    )
    .replace(
      /\bAsk (?:it|h(?:er)) how to use or extend Rin\./g,
      "Ask Rin how to use or extend Rin.",
    );
}

export function applyRinStartupHeaderBranding(instance: any) {
  const header = instance?.builtInHeader;
  if (!header || typeof header !== "object") return false;
  const upstreamVersion = String(instance?.version || "").trim();

  if (
    typeof header.getCollapsedText === "function" &&
    typeof header.getExpandedText === "function"
  ) {
    const getCollapsedText = header.getCollapsedText.bind(header);
    const getExpandedText = header.getExpandedText.bind(header);
    header.getCollapsedText = () =>
      rewriteRinStartupHeaderText(getCollapsedText(), upstreamVersion);
    header.getExpandedText = () =>
      rewriteRinStartupHeaderText(getExpandedText(), upstreamVersion);
    if (typeof header.setExpanded === "function") {
      header.setExpanded(Boolean(instance.getStartupExpansionState?.()));
    } else if (typeof header.setText === "function") {
      header.setText(header.getCollapsedText());
    }
    return true;
  }

  if (typeof header.text === "string" && typeof header.setText === "function") {
    header.setText(rewriteRinStartupHeaderText(header.text, upstreamVersion));
    return true;
  }

  return false;
}

export async function initializePiInteractiveModeWithoutManagedToolEnsure(
  instance: any,
) {
  if (instance.isInitialized) return;
  instance.registerSignalHandlers();
  instance.changelogMarkdown = instance.getChangelogForDisplay();
  instance.fdPath = getToolPath("fd") ?? undefined;

  if (
    instance.session.scopedModels.length > 0 &&
    (instance.options.verbose || !instance.settingsManager.getQuietStartup())
  ) {
    const modelList = instance.session.scopedModels
      .map((scopedModel: any) => {
        const thinkingStr = scopedModel.thinkingLevel
          ? `:${scopedModel.thinkingLevel}`
          : "";
        return `${scopedModel.model.id}${thinkingStr}`;
      })
      .join(", ");
    const cycleKeys = instance.keybindings.getKeys("app.model.cycleForward");
    const cycleHint =
      cycleKeys.length > 0
        ? theme.fg(
            "muted",
            ` (${formatKeyText(cycleKeys.join("/"), { capitalize: true })} to cycle)`,
          )
        : "";
    console.log(theme.fg("dim", `Model scope: ${modelList}${cycleHint}`));
  }

  instance.ui.addChild(instance.headerContainer);
  if (instance.options.verbose || !instance.settingsManager.getQuietStartup()) {
    const logo =
      theme.bold(theme.fg("accent", APP_NAME)) +
      theme.fg("dim", ` v${instance.version}`);
    const hint = (keybinding: string, description: string) =>
      keyHint(keybinding as any, description);
    const key = (keybinding: string) => keyText(keybinding as any);
    const expandedInstructions = [
      hint("app.interrupt", "to interrupt"),
      hint("app.clear", "to clear"),
      rawKeyHint(`${key("app.clear")} twice`, "to exit"),
      hint("app.exit", "to exit (empty)"),
      hint("app.suspend", "to suspend"),
      keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
      hint("app.thinking.cycle", "to cycle thinking level"),
      rawKeyHint(
        `${key("app.model.cycleForward")}/${key("app.model.cycleBackward")}`,
        "to cycle models",
      ),
      hint("app.model.select", "to select model"),
      hint("app.tools.expand", "to expand tools"),
      hint("app.thinking.toggle", "to expand thinking"),
      hint("app.editor.external", "for external editor"),
      rawKeyHint("/", "for commands"),
      rawKeyHint("!", "to run bash"),
      rawKeyHint("!!", "to run bash (no context)"),
      hint("app.message.followUp", "to queue follow-up"),
      hint("app.message.dequeue", "to edit all queued messages"),
      hint("app.clipboard.pasteImage", "to paste image"),
      rawKeyHint("drop files", "to attach"),
    ].join("\n");
    const compactInstructions = [
      hint("app.interrupt", "interrupt"),
      rawKeyHint(`${key("app.clear")}/${key("app.exit")}`, "clear/exit"),
      rawKeyHint("/", "commands"),
      rawKeyHint("!", "bash"),
      hint("app.tools.expand", "more"),
    ].join(theme.fg("muted", " · "));
    const compactOnboarding = theme.fg(
      "dim",
      `Press ${key("app.tools.expand")} to show full startup help and loaded resources.`,
    );
    const onboarding = theme.fg(
      "dim",
      "Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.",
    );
    instance.builtInHeader = new RinStartupExpandableText(
      () =>
        `${logo}\n${compactInstructions}\n${compactOnboarding}\n\n${onboarding}`,
      () => `${logo}\n${expandedInstructions}\n\n${onboarding}`,
      instance.getStartupExpansionState(),
      1,
      0,
    );
    instance.headerContainer.addChild(new Spacer(1));
    instance.headerContainer.addChild(instance.builtInHeader);
    instance.headerContainer.addChild(new Spacer(1));
  } else {
    instance.builtInHeader = new Text("", 0, 0);
    instance.headerContainer.addChild(instance.builtInHeader);
  }

  instance.ui.addChild(instance.chatContainer);
  instance.ui.addChild(instance.pendingMessagesContainer);
  instance.ui.addChild(instance.statusContainer);
  instance.renderWidgets();
  instance.ui.addChild(instance.widgetContainerAbove);
  instance.ui.addChild(instance.editorContainer);
  instance.ui.addChild(instance.widgetContainerBelow);
  instance.ui.addChild(instance.footer);
  instance.ui.setFocus(instance.editor);
  instance.setupKeyHandlers();
  instance.setupEditorSubmitHandler();
  instance.ui.start();
  instance.isInitialized = true;
  await instance.rebindCurrentSession();
  renderRinInitialSessionChrome(instance);
  instance.renderInitialMessages();
  onThemeChange(() => {
    instance.ui.invalidate();
    instance.updateEditorBorderColor();
    instance.ui.requestRender();
  });
  instance.footerDataProvider.onBranchChange(() => {
    instance.ui.requestRender();
  });
  await instance.updateAvailableProviderCount();
}

function enhanceBuiltInExtensionSettings(instance: any) {
  const selector = instance?.editorContainer?.children?.find(
    (child: any) => typeof child?.getSettingsList === "function",
  );
  const settingsList = selector?.getSettingsList?.();
  if (!settingsList || settingsList.__rinBuiltInExtensionsEnhanced) return;
  settingsList.__rinBuiltInExtensionsEnhanced = true;
  const states = listBuiltInRinExtensionStates(instance.settingsManager);
  for (const state of states) {
    settingsList.items.push({
      id: `rin-built-in-extension:${state.id}`,
      label: `Built-in: ${state.label}`,
      description: `${state.description} Reload or open a new session after changing this setting.`,
      currentValue: state.enabled ? "true" : "false",
      values: ["true", "false"],
    });
  }
  settingsList.filteredItems = settingsList.items;
  const originalOnChange = settingsList.onChange;
  settingsList.onChange = (id: string, newValue: string) => {
    if (String(id).startsWith("rin-built-in-extension:")) {
      const extensionId = String(id).slice("rin-built-in-extension:".length);
      void setBuiltInRinExtensionState(
        instance.settingsManager,
        extensionId,
        newValue === "true",
      )
        .then(async () => {
          if (typeof instance.session?.reload === "function") {
            await instance.session.reload();
            instance.setupAutocompleteProvider?.();
            instance.showStatus?.("Built-in extension settings reloaded.");
            return;
          }
          await instance.session?.call?.("reload").catch?.(() => {});
        })
        .catch((error) => {
          instance.showError?.(
            error instanceof Error ? error.message : String(error),
          );
        });
      return;
    }
    originalOnChange.call(settingsList, id, newValue);
  };
}

function createSessionSelectorLoaders(instance: any) {
  if (!isRpcTransportControlled(instance)) {
    const loadSessions = () =>
      listBoundSessions({
        cwd: instance.sessionManager.getCwd(),
        SessionManager,
      });
    return {
      currentSessionsLoader: loadSessions,
      allSessionsLoader: loadSessions,
      renameSession: async (
        sessionFilePath: string,
        nextName: string | undefined,
      ) =>
        await renameSessionIfNamed(
          (path, name) => renameBoundSession(path, name, { SessionManager }),
          sessionFilePath,
          nextName,
        ),
    };
  }

  const loadRemoteSessions = async () =>
    (await instance.session.listSessions("all")).map((session: any) => ({
      ...session,
      cwd: undefined,
    }));

  return {
    currentSessionsLoader: loadRemoteSessions,
    allSessionsLoader: loadRemoteSessions,
    renameSession: async (
      sessionFilePath: string,
      nextName: string | undefined,
    ) =>
      await renameSessionIfNamed(
        (path, name) => instance.session.renameSession(path, name),
        sessionFilePath,
        nextName,
      ),
  };
}

export async function applyRinTuiOverrides() {
  if (applied) return;
  applied = true;

  preserveScrollbackOnFullRedraw();

  const footerProto: any = FooterComponent?.prototype as any;
  const interactiveModeProto: any = InteractiveMode?.prototype as any;

  const originalRender = footerProto?.render;
  if (typeof originalRender === "function") {
    footerProto.render = function renderWithoutCwd(width: number) {
      const lines = renderWithRuntimeModeModelLabel(
        this,
        originalRender,
        width,
      );
      if (!Array.isArray(lines) || lines.length === 0) return lines;

      const sessionName = this?.session?.sessionManager?.getSessionName?.();
      const statsLine = lines[1] ?? lines[0];
      const nextLines = [];

      if (sessionName) {
        nextLines.push(truncateToWidth(dim(sessionName), width, dim("...")));
      }
      if (statsLine) nextLines.push(statsLine);
      for (const line of lines.slice(2)) {
        if (line) nextLines.push(line);
      }
      return nextLines;
    };
  }

  const originalInit = interactiveModeProto?.init;
  if (typeof originalInit === "function") {
    interactiveModeProto.init = async function initWithRinStartupBranding() {
      await initializePiInteractiveModeWithoutManagedToolEnsure(this);
      applyRinStartupHeaderBranding(this);
    };
  }

  const originalUpdateTerminalTitle = interactiveModeProto?.updateTerminalTitle;
  if (typeof originalUpdateTerminalTitle === "function") {
    interactiveModeProto.updateTerminalTitle =
      function updateTerminalTitleWithoutCwd() {
        const sessionName = this?.sessionManager?.getSessionName?.();
        this?.ui?.terminal?.setTitle?.(
          sessionName ? `Rin - ${sessionName}` : "Rin",
        );
      };
  }

  const originalSetupEditorSubmitHandler =
    interactiveModeProto?.setupEditorSubmitHandler;
  if (typeof originalSetupEditorSubmitHandler === "function") {
    interactiveModeProto.setupEditorSubmitHandler =
      function setupEditorSubmitHandlerWithStartupBuffer() {
        originalSetupEditorSubmitHandler.call(this);
        const originalSubmit = this.defaultEditor?.onSubmit;
        if (typeof originalSubmit !== "function") return;
        this.defaultEditor.onSubmit = async (text: string) => {
          const normalized = String(text || "").trim();
          const shouldBuffer = shouldBufferStartupInput(this, normalized);
          await originalSubmit.call(this.defaultEditor, text);
          if (shouldBuffer) getStartupInputQueue(this).push(normalized);
        };
      };
  }

  const originalGetUserInput = interactiveModeProto?.getUserInput;
  if (typeof originalGetUserInput === "function") {
    interactiveModeProto.getUserInput =
      function getUserInputWithStartupBuffer() {
        const queue = getStartupInputQueue(this);
        const next = queue.shift();
        if (next !== undefined) return Promise.resolve(next);
        return originalGetUserInput.call(this);
      };
  }

  const originalRun = interactiveModeProto?.run;
  if (typeof originalRun === "function") {
    interactiveModeProto.run = async function runWithRinUpdateNotices() {
      await this.init();
      scheduleRinUpdateNotificationWhenReady(this);
      for (const warning of this.options?.rinStartupWarnings || []) {
        if (warning) this.showWarning(warning);
      }
      this.checkTmuxKeyboardSetup?.().then((warning: string | undefined) => {
        if (warning) this.showWarning(warning);
      });

      const {
        migratedProviders,
        modelFallbackMessage,
        initialMessage,
        initialImages,
        initialMessages,
      } = this.options;
      if (migratedProviders && migratedProviders.length > 0) {
        this.showWarning(
          `Migrated credentials to auth.json: ${migratedProviders.join(", ")}`,
        );
      }
      const modelsJsonError = this.session.modelRegistry.getError();
      if (modelsJsonError)
        this.showError(`models.json error: ${modelsJsonError}`);
      if (modelFallbackMessage) this.showWarning(modelFallbackMessage);
      void this.maybeWarnAboutAnthropicSubscriptionAuth?.();

      if (initialMessage) {
        try {
          await this.session.prompt(initialMessage, { images: initialImages });
        } catch (error) {
          this.showError(
            error instanceof Error ? error.message : "Unknown error occurred",
          );
        }
      }
      if (initialMessages) {
        for (const message of initialMessages) {
          try {
            await this.session.prompt(message);
          } catch (error) {
            this.showError(
              error instanceof Error ? error.message : "Unknown error occurred",
            );
          }
        }
      }

      while (true) {
        const userInput = await this.getUserInput();
        try {
          await this.session.prompt(userInput);
        } catch (error) {
          this.showError(
            error instanceof Error ? error.message : "Unknown error occurred",
          );
        }
      }
    };
  }

  const originalGetChangelogForDisplay =
    interactiveModeProto?.getChangelogForDisplay;
  if (typeof originalGetChangelogForDisplay === "function") {
    interactiveModeProto.getChangelogForDisplay =
      function getRinChangelogForDisplay() {
        return getRinStartupChangelogForDisplay(this);
      };
  }

  const originalHandleChangelogCommand =
    interactiveModeProto?.handleChangelogCommand;
  if (typeof originalHandleChangelogCommand === "function") {
    interactiveModeProto.handleChangelogCommand =
      function handleRinChangelogCommand() {
        renderRinChangelog(this);
      };
  }

  const originalRenderSessionContext =
    interactiveModeProto?.renderSessionContext;
  if (typeof originalRenderSessionContext === "function") {
    interactiveModeProto.renderSessionContext =
      function renderSessionContextWithTodoCoalescing(
        sessionContext: any,
        options = {},
      ) {
        const result = originalRenderSessionContext.call(
          this,
          sessionContext,
          options,
        );
        if (coalesceTodoToolComponentsInContainer(this.chatContainer) > 0) {
          this.ui?.requestRender?.();
        }
        return result;
      };
  }

  const originalRebindCurrentSession =
    interactiveModeProto?.rebindCurrentSession;
  if (typeof originalRebindCurrentSession === "function") {
    interactiveModeProto.rebindCurrentSession =
      async function rebindCurrentSessionWithoutChatDecoration() {
        return await withoutRebindChatDecorations(this, () =>
          originalRebindCurrentSession.call(this),
        );
      };
  }

  if (typeof interactiveModeProto?.renderCurrentSessionState === "function") {
    interactiveModeProto.renderCurrentSessionState =
      function renderCurrentSessionStateWithRinStartupChrome() {
        renderRinCurrentSessionStateAfterReplacement(this);
      };
  }

  const originalShowSettingsSelector =
    interactiveModeProto?.showSettingsSelector;
  if (typeof originalShowSettingsSelector === "function") {
    interactiveModeProto.showSettingsSelector =
      function showSettingsSelectorWithBuiltInExtensions() {
        originalShowSettingsSelector.call(this);
        enhanceBuiltInExtensionSettings(this);
      };
  }

  const originalShowSessionSelector = interactiveModeProto?.showSessionSelector;
  if (typeof originalShowSessionSelector === "function") {
    interactiveModeProto.showSessionSelector =
      function showSessionSelectorFromRootSessionDir() {
        this.showSelector((done: any) => {
          const { currentSessionsLoader, allSessionsLoader, renameSession } =
            createSessionSelectorLoaders(this);
          const selector = new SessionSelectorComponent(
            currentSessionsLoader,
            allSessionsLoader,
            async (sessionPath: string) => {
              done();
              await this.handleResumeSession(sessionPath);
            },
            () => {
              done();
              this.ui.requestRender();
            },
            () => {
              void this.shutdown();
            },
            () => this.ui.requestRender(),
            {
              renameSession,
              showRenameHint: true,
              keybindings: this.keybindings,
            },
            this.sessionManager.getSessionFile(),
          );
          configureRootSessionSelectorPresentation(selector);
          return { component: selector, focus: selector };
        });
      };
  }

  const originalRegisterSignalHandlers =
    interactiveModeProto?.registerSignalHandlers;
  if (typeof originalRegisterSignalHandlers === "function") {
    interactiveModeProto.registerSignalHandlers =
      function registerSignalHandlersWithSigintFallback() {
        originalRegisterSignalHandlers.call(this);
        const handler = () => {
          if (shouldIgnoreInteractiveSigint(this)) return;
          this.handleCtrlC?.();
        };
        process.on("SIGINT", handler);
        this.signalCleanupHandlers.push(() => process.off("SIGINT", handler));
      };
  }

  const originalHandleEvent = interactiveModeProto?.handleEvent;
  if (typeof originalHandleEvent === "function") {
    interactiveModeProto.handleEvent = async function handleEventWithRpcStates(
      event: any,
    ) {
      getLocalUserEchoQueue(this);
      if (!this.isInitialized) {
        await this.init();
      }

      if (event?.type === "rpc_frontend_status") {
        syncRpcFrontendStatus(this, event);
        return;
      }

      if (event?.type === "rpc_local_user_message") {
        const text = String(event.text || "").trim();
        if (!text) return;
        getLocalUserEchoQueue(this).push(text);
        await originalHandleEvent.call(this, {
          type: "message_start",
          message: {
            role: "user",
            content: [{ type: "text", text }],
          },
        });
        return;
      }

      if (event?.type === "rpc_session_resynced") {
        resetLocalUserEchoQueue(this);
        if (typeof this.handleRuntimeSessionChange === "function") {
          await this.handleRuntimeSessionChange();
        }
        redrawCurrentSessionHistoryAfterRpcResync(this);
        syncRpcFrontendStatus(this);
        return;
      }

      if (event?.type === "self_improve_review_notice") {
        showSelfImproveReviewNotice(this, event);
        return;
      }

      if (shouldSuppressLocalUserEcho(this, event)) return;

      const shouldReapplyLocalPiLoader = shouldReapplyLocalPiLoaderAfterEvent(
        this,
        event,
      );

      stopRpcTransportStatusComponent(this);
      await originalHandleEvent.call(this, event);

      const todoCoalesced = shouldCoalesceTodoAfterEvent(event)
        ? coalesceTodoToolComponentsInContainer(this.chatContainer)
        : 0;

      syncRpcFrontendStatus(this);
      if (shouldReapplyLocalPiLoader) {
        syncLocalPiLoader(this);
      }
      if (todoCoalesced > 0) {
        this.ui?.requestRender?.();
      }
    };
  }
}
