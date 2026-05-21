import {
  DynamicBorder,
  FooterComponent,
  InteractiveMode,
  keyHint,
  SessionManager,
  SessionSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import {
  Loader,
  Markdown,
  ProcessTerminal,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import { theme } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

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
const RPC_TRANSPORT_REAPPLY_EVENTS = new Set([
  "agent_end",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
]);
const LOCAL_USER_ECHO_QUEUE_KEY = "__rinLocalUserEchoQueue";
const STARTUP_INPUT_QUEUE_KEY = "__rinStartupInputQueue";
const RPC_TRANSPORT_STATUS_COMPONENT_KEY = "__rinRpcTransportStatusComponent";
const RPC_TRANSPORT_STATUS_MESSAGE_KEY = "__rinRpcTransportStatusMessage";
const RPC_TRANSPORT_STATUS_PHASES = new Set([
  "starting",
  "connecting",
  "sending",
]);
const TODO_TOOL_COALESCE_EVENTS = new Set(["tool_execution_end", "agent_end"]);

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

function syncRpcPiLoader(instance: any) {
  if (!isRpcTransportControlled(instance)) return;
  const status = instance.session.getFrontendStatusEvent?.();
  if (status?.phase === "working") {
    reattachExistingPiLoader(instance);
  }
}

function syncLocalPiLoader(instance: any) {
  if (isRpcTransportControlled(instance)) return;
  if (!instance?.session?.isStreaming) return;
  reattachExistingPiLoader(instance);
}

function shouldReapplyRpcPiLoaderAfterEvent(instance: any, event: any) {
  return (
    isRpcTransportControlled(instance) &&
    RPC_TRANSPORT_REAPPLY_EVENTS.has(String(event?.type || ""))
  );
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

function redrawCurrentSessionHistoryAfterRpcResync(instance: any) {
  instance.chatContainer?.clear?.();
  instance.pendingMessagesContainer?.clear?.();
  instance.compactionQueuedMessages = [];
  instance.streamingComponent = undefined;
  instance.streamingMessage = undefined;
  instance.pendingTools?.clear?.();
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

export function insertRinUpdateNotificationPlaceholder(instance: any) {
  if (typeof instance?.chatContainer?.addChild !== "function") return undefined;
  const placeholder = new DeferredRinUpdateNotification();
  instance.chatContainer.addChild(placeholder);
  return placeholder;
}

export function showRinUpdateNotification(
  instance: any,
  notice: RinUpdateNotice,
  placeholder?: DeferredRinUpdateNotification,
) {
  const text = formatRinUpdateNotificationText(notice);
  if (placeholder) {
    placeholder.setText(`Warning: ${text}`);
    instance?.ui?.requestRender?.();
    return;
  }
  if (typeof instance?.showWarning === "function") {
    instance.showWarning(text);
    return;
  }
  instance?.chatContainer?.addChild?.(new Spacer(1));
  instance?.chatContainer?.addChild?.(new Text(`Warning: ${text}`, 1, 0));
  instance?.ui?.requestRender?.();
}

function scheduleRinUpdateNotificationWhenReady(instance: any) {
  const placeholder = insertRinUpdateNotificationPlaceholder(instance);
  void sleep(0).then(() =>
    showRinUpdateNotificationWhenReady(instance, placeholder),
  );
}

async function showRinUpdateNotificationWhenReady(
  instance: any,
  placeholder?: DeferredRinUpdateNotification,
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
      "Rin can explain her own features and look up her docs.",
    )
    .replace(
      /\bAsk it how to use or extend Pi\./g,
      "Ask her how to use or extend Rin.",
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
      /\bRin can explain its own features and look up its docs\./g,
      "Rin can explain her own features and look up her docs.",
    )
    .replace(
      /\bAsk it how to use or extend Rin\./g,
      "Ask her how to use or extend Rin.",
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
      await originalInit.call(this);
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
        if (event.phase === "working") {
          reattachExistingPiLoader(this);
        } else {
          showRpcTransportStatus(this, event);
        }
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
        syncRpcPiLoader(this);
        return;
      }

      if (shouldSuppressLocalUserEcho(this, event)) return;

      const shouldReapplyRpcPiLoader = shouldReapplyRpcPiLoaderAfterEvent(
        this,
        event,
      );
      const shouldReapplyLocalPiLoader = shouldReapplyLocalPiLoaderAfterEvent(
        this,
        event,
      );

      stopRpcTransportStatusComponent(this);
      await originalHandleEvent.call(this, event);

      const todoCoalesced = shouldCoalesceTodoAfterEvent(event)
        ? coalesceTodoToolComponentsInContainer(this.chatContainer)
        : 0;

      if (shouldReapplyRpcPiLoader) {
        syncRpcPiLoader(this);
      }
      if (shouldReapplyLocalPiLoader) {
        syncLocalPiLoader(this);
      }
      if (todoCoalesced > 0) {
        this.ui?.requestRender?.();
      }
    };
  }
}
