import { writeSync } from "node:fs";

import {
  DynamicBorder,
  FooterComponent,
  InteractiveMode,
  keyHint,
  keyText,
  rawKeyHint,
  SessionManager,
  SessionSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import {
  APP_NAME,
  formatKeyText,
  getToolPath,
  onThemeChange,
  stopThemeWatcher,
  theme,
} from "../private-api.js";
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
} from "../../rin-builtin-extension-controls.js";

import { sleep } from "../../platform/process.js";
import {
  checkForRinUpdateNotice,
  getCurrentRinVersion,
  getNewRinChangelogEntries,
  getRinChangelogUrl,
  parsePackageVersion,
  readRinChangelogEntries,
  type RinUpdateNotice,
} from "../../rin-lib/update-notices.js";
import { formatRuntimeErrorForFrontendDisplay } from "../../rin-lib/user-facing-errors.js";
import { extractMessageText } from "../../message-content.js";
import {
  listBoundSessionPage,
  renameBoundSession,
} from "../../session/factory.js";
import {
  getRinTuiRuntimeRole,
  RIN_TUI_MAINTENANCE_ROLE,
  RIN_TUI_RPC_FRONTEND_ROLE,
} from "../../tui-runtime-env.js";

let applied = false;
const ANSI_DIM = "\u001b[2m";
const ANSI_RESET = "\u001b[0m";
const CLEAR_SCROLLBACK_SEQUENCE = "\u001b[3J";
const PRESERVE_SCROLLBACK_PATCH = Symbol.for(
  "rin.tui.preserve_scrollback_full_redraw",
);
const LOCAL_USER_ECHO_QUEUE_KEY = "__rinLocalUserEchoQueue";
const RPC_TRANSPORT_STATUS_COMPONENT_KEY = "__rinRpcTransportStatusComponent";
const RPC_TRANSPORT_STATUS_MESSAGE_KEY = "__rinRpcTransportStatusMessage";
const RPC_TRANSPORT_STATUS_KIND = "rinRpcTransport";
const SESSION_SELECTOR_PAGE_SIZE = 30;
const RPC_TRANSPORT_STATUS_PHASES = new Set([
  "starting",
  "connecting",
  "sending",
]);

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

export function formatRinFatalError(prefix: unknown, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const headline = `${String(prefix || "TUI failure")}: ${message}`;
  const stack = error instanceof Error ? String(error.stack || "").trim() : "";
  const stackHeader =
    error instanceof Error ? `${error.name}: ${error.message}` : "";
  const details = stack && stack !== stackHeader ? `\n${stack}` : "";
  return `\nRin fatal error\n${headline}${details}\n`;
}

export function writeRinFatalError(prefix: unknown, error: unknown) {
  let output = "\nRin fatal error\nUnable to format the original failure.\n";
  try {
    output = formatRinFatalError(prefix, error);
  } catch {}
  try {
    writeSync(2, output);
  } catch {
    try {
      process.stderr.write(output);
    } catch {}
  }
}

function exitRinTuiAfterFatalError(
  instance: any,
  prefix: unknown,
  error: unknown,
): never {
  const cleanupErrors: unknown[] = [];
  try {
    try {
      stopThemeWatcher();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      instance.stop();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
  } finally {
    writeRinFatalError(prefix, error);
    for (const cleanupError of cleanupErrors) {
      writeRinFatalError("TUI cleanup also failed", cleanupError);
    }
    process.exit(1);
  }
}

const RESUME_SESSION_PROMPT_TEXT = "To resume this session:";
const ANSI_ESCAPE_CHAR = "\u001b";

function skipAnsiEscapeSequence(text: string, start: number) {
  if (text[start] !== ANSI_ESCAPE_CHAR || text[start + 1] !== "[") {
    return start;
  }
  let index = start + 2;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index + 1;
    index += 1;
  }
  return start;
}

function skipAnsiAndWhitespace(text: string, start: number) {
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    const nextIndex = skipAnsiEscapeSequence(text, index);
    if (nextIndex !== index) {
      index = nextIndex;
      continue;
    }
    break;
  }
  return index;
}

export function rewriteRinResumeCommandOutput(chunk: unknown) {
  if (typeof chunk !== "string") return chunk;

  let output = chunk;
  let searchFrom = 0;
  while (searchFrom < output.length) {
    const promptIndex = output.indexOf(RESUME_SESSION_PROMPT_TEXT, searchFrom);
    if (promptIndex < 0) break;

    const commandStart = skipAnsiAndWhitespace(
      output,
      promptIndex + RESUME_SESSION_PROMPT_TEXT.length,
    );
    const nextChar = output[commandStart + 2];
    if (
      output.startsWith("pi", commandStart) &&
      (nextChar === undefined || /\s/.test(nextChar))
    ) {
      output = `${output.slice(0, commandStart)}rin${output.slice(commandStart + 2)}`;
      searchFrom = commandStart + 3;
      continue;
    }

    searchFrom = promptIndex + RESUME_SESSION_PROMPT_TEXT.length;
  }
  return output;
}

async function withRinResumeCommandOutput<T>(operation: () => T | Promise<T>) {
  const stdout = process.stdout as any;
  const originalWrite = stdout?.write;
  if (typeof originalWrite !== "function") return await operation();

  stdout.write = function writeWithRinResumeCommand(
    chunk: unknown,
    ...args: any[]
  ) {
    return originalWrite.call(
      this,
      rewriteRinResumeCommandOutput(chunk),
      ...args,
    );
  };

  try {
    return await operation();
  } finally {
    stdout.write = originalWrite;
  }
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

class RinRpcTransportStatusIndicator extends Loader {
  readonly kind = RPC_TRANSPORT_STATUS_KIND;

  constructor(
    private instance: any,
    message: string,
  ) {
    super(instance.ui, (text: string) => text, dim, message);
  }

  dispose() {
    this.stop();
    if (this.instance?.[RPC_TRANSPORT_STATUS_COMPONENT_KEY] === this) {
      this.instance[RPC_TRANSPORT_STATUS_COMPONENT_KEY] = undefined;
      this.instance[RPC_TRANSPORT_STATUS_MESSAGE_KEY] = undefined;
    }
  }
}

function stopRpcTransportStatusComponent(instance: any) {
  const component = instance?.[RPC_TRANSPORT_STATUS_COMPONENT_KEY];
  if (!component) return false;
  instance.clearStatusIndicator(RPC_TRANSPORT_STATUS_KIND);
  if (instance?.[RPC_TRANSPORT_STATUS_COMPONENT_KEY] === component) {
    component.dispose();
  }
  return true;
}

function createRpcTransportStatusIndicator(instance: any, message: string) {
  return new RinRpcTransportStatusIndicator(instance, message);
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
  const previousMessage = instance?.[RPC_TRANSPORT_STATUS_MESSAGE_KEY];
  if (component && previousMessage === message) return;

  if (!component) {
    component = createRpcTransportStatusIndicator(instance, message);
    instance[RPC_TRANSPORT_STATUS_COMPONENT_KEY] = component;
    instance.showStatusIndicator(component);
  } else if (previousMessage !== message) {
    component.setMessage(message);
  }
  instance[RPC_TRANSPORT_STATUS_MESSAGE_KEY] = message;
}

function syncPiWorkingStatusFromSession(instance: any) {
  const clearedTransportStatus = stopRpcTransportStatusComponent(instance);
  if (
    instance?.workingVisible !== false &&
    instance?.session?.isStreaming &&
    typeof instance?.setWorkingVisible === "function"
  ) {
    instance.setWorkingVisible(true);
  }
  if (clearedTransportStatus) instance?.ui?.requestRender?.();
}

function syncRpcFrontendStatus(instance: any, statusOverride?: any) {
  if (!isRpcTransportControlled(instance)) return;
  const status = statusOverride ?? instance.session.getFrontendStatusEvent?.();
  const phase = String(status?.phase || "");
  if (phase === "working") {
    syncPiWorkingStatusFromSession(instance);
    return;
  }
  if (phase === "compacting" || phase === "retrying") {
    const changed = stopRpcTransportStatusComponent(instance);
    if (changed) instance?.ui?.requestRender?.();
    return;
  }
  if (RPC_TRANSPORT_STATUS_PHASES.has(phase)) {
    showRpcTransportStatus(instance, status);
    return;
  }
  const changed = stopRpcTransportStatusComponent(instance);
  if (changed || phase === "idle") instance?.ui?.requestRender?.();
}

function syncLocalPiWorkingStatus(instance: any) {
  if (isRpcTransportControlled(instance)) return;
  if (!instance?.session?.isStreaming) return;
  instance.setWorkingVisible(instance?.workingVisible !== false);
}

function shouldSyncLocalWorkingAfterEvent(instance: any, event: any) {
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
}

export function renderRinCurrentSessionStateAfterReplacement(instance: any) {
  clearCurrentSessionRenderState(instance);
  if (!currentSessionHasRenderedHistory(instance)) {
    renderRinInitialSessionChrome(instance);
  }
  instance.renderInitialMessages?.();
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
  const updateInstruction =
    theme.fg(
      "muted",
      `New ${channelPrefix}version ${notice.version} is available. Run `,
    ) + theme.fg("accent", notice.command);
  const changelogLine =
    theme.fg("muted", "Changelog: ") + theme.fg("accent", getRinChangelogUrl());
  return [
    theme.bold(theme.fg("warning", "Update Available")),
    updateInstruction,
    changelogLine,
  ].join("\n");
}

export function showRinUpdateNotification(
  instance: any,
  notice: RinUpdateNotice,
) {
  const text = formatRinUpdateNotificationText(notice);
  instance.chatContainer.addChild(new Spacer(1));
  instance.chatContainer.addChild(
    new DynamicBorder((borderText) => theme.fg("warning", borderText)),
  );
  instance.chatContainer.addChild(new Text(text, 1, 0));
  instance.chatContainer.addChild(
    new DynamicBorder((borderText) => theme.fg("warning", borderText)),
  );
  instance?.ui?.requestRender?.();
}

function scheduleRinUpdateNotificationWhenReady(instance: any) {
  void sleep(0).then(() => showRinUpdateNotificationWhenReady(instance));
}

async function showRinUpdateNotificationWhenReady(instance: any) {
  try {
    const notice = await checkForRinUpdateNotice();
    if (!notice) return;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (instance?.isInitialized) break;
      await sleep(50);
    }
    showRinUpdateNotification(instance, notice);
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

function shouldHideRinStartupVersion() {
  return Boolean(process.env.RIN_QUICK_RUN);
}

function formatRinStartupVersionLabel(version = getCurrentRinVersion()) {
  if (shouldHideRinStartupVersion()) return "";
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
    const versionLabel = formatRinStartupVersionLabel(rinVersion);
    next = next.split(`v${upstreamVersionText}`).join(versionLabel);
    if (!versionLabel) next = next.replace(/[ \t]+\n/g, "\n");
  } else if (shouldHideRinStartupVersion()) {
    next = next.replace(/\brin\s+v[0-9A-Za-z.+-]+/i, "Rin");
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
  instance.ui.addChild(instance.loadedResourcesContainer);
  if (instance.options.verbose || !instance.settingsManager.getQuietStartup()) {
    const logo =
      theme.bold(theme.fg("accent", APP_NAME)) +
      (shouldHideRinStartupVersion()
        ? ""
        : theme.fg("dim", ` v${instance.version}`));
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

type SessionSelectorPageFetch = (options: {
  offset: number;
  limit: number;
}) => Promise<unknown>;

type SessionSelectorPageState = {
  sessions: any[];
  total: number;
  nextOffset: number;
  hasMore: boolean;
  loading: boolean;
  loadInitial: (
    onProgress?: (loaded: number, total: number) => void,
  ) => Promise<any[]>;
  loadNext: (selector: any, scope: "current" | "all") => Promise<void>;
};

type SessionSelectorPageStates = {
  current: SessionSelectorPageState;
  all: SessionSelectorPageState;
};

function normalizeSessionSelectorPage(
  value: unknown,
  fallbackOffset: number,
  fallbackLimit: number,
) {
  const source = value && typeof value === "object" ? (value as any) : {};
  const sessions = Array.isArray(value)
    ? value
    : Array.isArray(source.sessions)
      ? source.sessions
      : [];
  const offset = Number.isFinite(Number(source.offset))
    ? Math.max(0, Number(source.offset))
    : fallbackOffset;
  const limit = Number.isFinite(Number(source.limit))
    ? Math.max(1, Number(source.limit))
    : fallbackLimit;
  const total = Number.isFinite(Number(source.total))
    ? Math.max(0, Number(source.total))
    : sessions.length;
  const nextOffset = Number.isFinite(Number(source.nextOffset))
    ? Math.max(0, Number(source.nextOffset))
    : offset + sessions.length;
  return {
    sessions,
    offset,
    limit,
    total,
    nextOffset,
    hasMore: Boolean(source.hasMore) || nextOffset < total,
  };
}

function mergeSessionPages(existing: any[], next: any[]): any[] {
  const seen = new Set<string>();
  const merged = [];
  for (const session of [...existing, ...next]) {
    const key = String(session?.path || session?.id || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(session);
  }
  return merged;
}

function updateSelectorPageSessions(
  selector: any,
  scope: "current" | "all",
  state: SessionSelectorPageState,
) {
  if (!selector) return;
  if (scope === "all") {
    selector.allSessions = state.sessions;
  } else {
    selector.currentSessions = state.sessions;
  }
  if (selector.scope !== scope) return;
  selector.sessionList?.setSessions?.(state.sessions, scope === "all");
  selector.header?.setProgress?.(
    state.sessions.length,
    state.total || state.sessions.length,
  );
  selector.requestRender?.();
}

function createSessionSelectorPageState(
  fetchPage: SessionSelectorPageFetch,
): SessionSelectorPageState {
  const state: SessionSelectorPageState = {
    sessions: [],
    total: 0,
    nextOffset: 0,
    hasMore: true,
    loading: false,
    async loadInitial(onProgress) {
      state.sessions = [];
      state.total = 0;
      state.nextOffset = 0;
      state.hasMore = true;
      state.loading = true;
      try {
        const page = normalizeSessionSelectorPage(
          await fetchPage({ offset: 0, limit: SESSION_SELECTOR_PAGE_SIZE }),
          0,
          SESSION_SELECTOR_PAGE_SIZE,
        );
        state.sessions = page.sessions;
        state.total = page.total;
        state.nextOffset = page.nextOffset;
        state.hasMore = page.hasMore;
        onProgress?.(
          state.sessions.length,
          state.total || state.sessions.length,
        );
        return state.sessions;
      } finally {
        state.loading = false;
      }
    },
    async loadNext(selector, scope) {
      if (state.loading || !state.hasMore) return;
      state.loading = true;
      try {
        const page = normalizeSessionSelectorPage(
          await fetchPage({
            offset: state.nextOffset,
            limit: SESSION_SELECTOR_PAGE_SIZE,
          }),
          state.nextOffset,
          SESSION_SELECTOR_PAGE_SIZE,
        );
        state.sessions = mergeSessionPages(state.sessions, page.sessions);
        state.total = page.total;
        state.nextOffset = page.nextOffset;
        state.hasMore = page.hasMore;
        updateSelectorPageSessions(selector, scope, state);
      } catch (error) {
        selector?.header?.setStatusMessage?.(
          {
            type: "error",
            message: `Failed to load more sessions: ${error instanceof Error ? error.message : String(error)}`,
          },
          4000,
        );
        selector?.requestRender?.();
      } finally {
        state.loading = false;
      }
    },
  };
  return state;
}

function maybeLoadNextSessionSelectorPage(
  selector: any,
  states: SessionSelectorPageStates,
) {
  const scope = selector?.scope === "all" ? "all" : "current";
  const state = states[scope];
  if (!state?.hasMore || state.loading) return;
  const sessionList = selector?.sessionList;
  const filteredCount = Array.isArray(sessionList?.filteredSessions)
    ? sessionList.filteredSessions.length
    : 0;
  const selectedIndex = Number.isFinite(Number(sessionList?.selectedIndex))
    ? Number(sessionList.selectedIndex)
    : 0;
  if (filteredCount === 0 || selectedIndex >= filteredCount - 3) {
    void state.loadNext(selector, scope);
  }
}

function attachSessionSelectorPagination(
  selector: any,
  states: SessionSelectorPageStates,
) {
  if (
    !selector?.sessionList ||
    typeof selector.sessionList.handleInput !== "function"
  ) {
    return;
  }
  Object.defineProperty(selector, "__rinSessionPagination", {
    value: states,
    configurable: true,
  });
  const originalHandleInput = selector.sessionList.handleInput.bind(
    selector.sessionList,
  );
  selector.sessionList.handleInput = (data: unknown) => {
    originalHandleInput(data);
    maybeLoadNextSessionSelectorPage(selector, states);
  };
}

function createSessionSelectorLoaders(instance: any) {
  const createLocalState = () =>
    createSessionSelectorPageState(
      async ({ offset, limit }) =>
        await listBoundSessionPage({
          cwd: instance.sessionManager.getCwd(),
          offset,
          limit,
        }),
    );

  const createRemoteState = () =>
    createSessionSelectorPageState(async ({ offset, limit }) => {
      if (typeof instance.session?.listSessionPage === "function") {
        return await instance.session.listSessionPage("all", { offset, limit });
      }
      return {
        sessions: (await instance.session.listSessions("all")).map(
          (session: any) => ({
            ...session,
            cwd: undefined,
          }),
        ),
        offset: 0,
        limit: Number.MAX_SAFE_INTEGER,
        hasMore: false,
      };
    });

  const pageStates: SessionSelectorPageStates = isRpcTransportControlled(
    instance,
  )
    ? { current: createRemoteState(), all: createRemoteState() }
    : { current: createLocalState(), all: createLocalState() };

  return {
    currentSessionsLoader: pageStates.current.loadInitial,
    allSessionsLoader: pageStates.all.loadInitial,
    pageStates,
    renameSession: async (
      sessionFilePath: string,
      nextName: string | undefined,
    ) =>
      await renameSessionIfNamed(
        (path, name) =>
          isRpcTransportControlled(instance)
            ? instance.session.renameSession(path, name)
            : renameBoundSession(path, name, { SessionManager }),
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

  const originalShutdown = interactiveModeProto?.shutdown;
  if (typeof originalShutdown === "function") {
    interactiveModeProto.shutdown = async function shutdownWithRinResumeCommand(
      ...args: any[]
    ) {
      return await withRinResumeCommandOutput(() =>
        originalShutdown.apply(this, args),
      );
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
      if (this.options?.rinStartHiddenInitialization) {
        try {
          await this.session.prompt("", {
            requestTag: "rin-init-startup",
            source: "rin-init",
          });
        } catch (error) {
          this.showError(
            error instanceof Error ? error.message : "Unknown error occurred",
          );
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

  const originalHandleFatalRuntimeError =
    interactiveModeProto?.handleFatalRuntimeError;
  if (typeof originalHandleFatalRuntimeError === "function") {
    interactiveModeProto.handleFatalRuntimeError =
      function handleFatalRuntimeErrorWithReadableTerminalOutput(
        prefix: unknown,
        error: unknown,
      ) {
        exitRinTuiAfterFatalError(this, prefix, error);
      };
  }

  const originalCycleThinkingLevel = interactiveModeProto?.cycleThinkingLevel;
  if (typeof originalCycleThinkingLevel === "function") {
    interactiveModeProto.cycleThinkingLevel =
      function cycleRpcThinkingLevelAfterAcknowledgement() {
        if (!isRpcTransportControlled(this)) {
          return originalCycleThinkingLevel.call(this);
        }
        return Promise.resolve(this.session.cycleThinkingLevel())
          .then((newLevel: unknown) => {
            if (newLevel === undefined) {
              this.showStatus("Current model does not support thinking");
              return;
            }
            this.footer.invalidate();
            this.updateEditorBorderColor();
            this.showStatus(`Thinking level: ${String(newLevel)}`);
          })
          .catch((error: unknown) => {
            this.showError(
              `Failed to save thinking level: ${formatRuntimeErrorForFrontendDisplay(error)}`,
            );
          });
      };
  }

  const originalRebindCurrentSession =
    interactiveModeProto?.rebindCurrentSession;
  if (typeof originalRebindCurrentSession === "function") {
    interactiveModeProto.rebindCurrentSession =
      async function rebindCurrentSessionWithoutChatDecoration(...args: any[]) {
        return await withoutRebindChatDecorations(this, () =>
          originalRebindCurrentSession.apply(this, args),
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
          const {
            currentSessionsLoader,
            allSessionsLoader,
            renameSession,
            pageStates,
          } = createSessionSelectorLoaders(this);
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
          attachSessionSelectorPagination(selector, pageStates);
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
        const terminalClosedHandler = () => {
          if (shouldIgnoreInteractiveSigint(this)) return;
          this.emergencyTerminalExit?.();
        };
        process.stdin.once("end", terminalClosedHandler);
        process.stdin.once("close", terminalClosedHandler);
        this.signalCleanupHandlers.push(() => {
          process.stdin.off("end", terminalClosedHandler);
          process.stdin.off("close", terminalClosedHandler);
        });
      };
  }

  const originalSubscribeToAgent = interactiveModeProto?.subscribeToAgent;
  if (typeof originalSubscribeToAgent === "function") {
    interactiveModeProto.subscribeToAgent =
      function subscribeToAgentWithFatalErrorBoundary() {
        const handleReportingFailure = (error: unknown) => {
          writeRinFatalError("Failed to report session event failure", error);
          process.exit(1);
        };
        const handleFailure = (error: unknown) => {
          let result: unknown;
          try {
            result = this.handleFatalRuntimeError(
              "Failed to handle session event",
              error,
            );
          } catch (reportingError) {
            handleReportingFailure(reportingError);
            return;
          }
          void Promise.resolve(result).catch(handleReportingFailure);
        };
        this.unsubscribe = this.session.subscribe((event: unknown) => {
          let result: unknown;
          try {
            result = this.handleEvent(event);
          } catch (error) {
            handleFailure(error);
            return;
          }
          void Promise.resolve(result).catch(handleFailure);
        });
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

      if (event?.type === "rpc_settings_mutation_error") {
        this.showError(
          `Failed to save setting: ${String(event.error || "unknown error")}`,
        );
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

      if (shouldSuppressLocalUserEcho(this, event)) return;

      const shouldSyncLocalWorking = shouldSyncLocalWorkingAfterEvent(
        this,
        event,
      );

      stopRpcTransportStatusComponent(this);
      await originalHandleEvent.call(this, event);

      syncRpcFrontendStatus(this);
      if (shouldSyncLocalWorking) {
        syncLocalPiWorkingStatus(this);
      }
    };
  }
}
