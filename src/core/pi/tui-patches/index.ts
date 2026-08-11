import { existsSync } from "node:fs";

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
  theme,
} from "../private-api.js";
import {
  Loader,
  Markdown,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import { sleep } from "../../platform/process.js";
import {
  checkForRinUpdateNotice,
  comparePackageVersions,
  getCurrentRinVersion,
  getRinChangelogUrl,
  getRinStartupChangelogEntries,
  parsePackageVersion,
  processRinGitStartupChangelog,
  readInstalledRinReleaseInfo,
  readRinChangelogEntries,
  type RinGitChangelogNotice,
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

function rawRinTuiErrorMessage(error: unknown) {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "unknown error";
  }
}

function isRpcTransportStatusError(error: unknown) {
  return /\brin_(?:tui_not_connected|disconnected|session_recovering)\b/.test(
    rawRinTuiErrorMessage(error),
  );
}

function formatRecoverableRinTuiError(prefix: unknown, error: unknown) {
  const rawMessage = rawRinTuiErrorMessage(error);
  const message =
    /\brin_(?:tui_not_connected|disconnected|session_recovering)\b/.test(
      rawMessage,
    )
      ? "daemon disconnected; reconnecting"
      : formatRuntimeErrorForFrontendDisplay(error);
  return `${String(prefix || "TUI operation failed")}: ${message}`;
}

function writeRecoverableRinTuiError(
  message: string,
  reportingError?: unknown,
) {
  const reportingMessage = reportingError
    ? `\nUnable to render this error: ${rawRinTuiErrorMessage(reportingError)}`
    : "";
  try {
    process.stderr.write(`\nRin TUI error\n${message}${reportingMessage}\n`);
  } catch {}
}

function reportRecoverableRinTuiError(
  instance: any,
  prefix: unknown,
  error: unknown,
  priorReportingError?: unknown,
) {
  if (isRpcTransportControlled(instance) && isRpcTransportStatusError(error)) {
    return;
  }
  let message: string;
  try {
    message = formatRecoverableRinTuiError(prefix, error);
  } catch (formattingError) {
    message = `${String(prefix || "TUI operation failed")}: ${rawRinTuiErrorMessage(error)}`;
    priorReportingError ??= formattingError;
  }
  let reportingResult: unknown;
  try {
    if (typeof instance?.showError !== "function") {
      writeRecoverableRinTuiError(message, priorReportingError);
      return;
    }
    reportingResult = instance.showError(message);
  } catch (reportingError) {
    writeRecoverableRinTuiError(message, priorReportingError || reportingError);
    return;
  }
  try {
    void Promise.resolve(reportingResult).catch((reportingError) => {
      writeRecoverableRinTuiError(
        message,
        priorReportingError || reportingError,
      );
    });
  } catch (reportingError) {
    writeRecoverableRinTuiError(message, priorReportingError || reportingError);
  }
}

function runRecoverableRinTuiOperation(
  instance: any,
  prefix: string,
  operation: () => unknown,
) {
  let result: unknown;
  try {
    result = operation();
  } catch (error) {
    reportRecoverableRinTuiError(instance, prefix, error);
    return;
  }
  void Promise.resolve(result).catch((error) => {
    reportRecoverableRinTuiError(instance, prefix, error);
  });
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
  const session = footer?.session;
  const originalModelRuntime = session?.modelRuntime;
  const needsModelRuntimeShim =
    session &&
    (typeof originalModelRuntime?.isUsingOAuth !== "function" ||
      typeof originalModelRuntime?.isUsingSubscription !== "function");
  if (needsModelRuntimeShim) {
    session.modelRuntime = {
      ...(originalModelRuntime || {}),
      isUsingOAuth(provider: string) {
        return Boolean(
          originalModelRuntime?.isUsingOAuth?.(provider) ||
          session.modelRegistry?.isUsingOAuth?.({ provider }) ||
          session.modelRegistry?.isUsingOAuth?.(provider),
        );
      },
      isUsingSubscription(provider: string) {
        return Boolean(originalModelRuntime?.isUsingSubscription?.(provider));
      },
    };
  }
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
    if (needsModelRuntimeShim && session) {
      if (originalModelRuntime) session.modelRuntime = originalModelRuntime;
      else delete session.modelRuntime;
    }
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

function syncRpcFrontendStatus(instance: any, statusOverride?: any) {
  if (!isRpcTransportControlled(instance)) return;
  const status = statusOverride ?? instance.session.getFrontendStatusEvent?.();
  const phase = String(status?.phase || "");
  if (phase === "working" || phase === "compacting" || phase === "retrying") {
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

type LocalUserEcho = {
  text: string;
  renderedChildren: unknown[];
};

function getLocalUserEchoQueue(instance: any): LocalUserEcho[] {
  const queue = instance[LOCAL_USER_ECHO_QUEUE_KEY];
  if (Array.isArray(queue)) return queue;
  const nextQueue: LocalUserEcho[] = [];
  instance[LOCAL_USER_ECHO_QUEUE_KEY] = nextQueue;
  return nextQueue;
}

async function renderLocalUserEcho(
  instance: any,
  localEcho: LocalUserEcho,
  handleEvent: (...args: any[]) => unknown,
) {
  const children = Array.isArray(instance.chatContainer?.children)
    ? instance.chatContainer.children
    : [];
  const previousChildren = new Set(children);
  await handleEvent.call(instance, {
    type: "message_start",
    message: {
      role: "user",
      content: [{ type: "text", text: localEcho.text }],
    },
  });
  localEcho.renderedChildren = children.filter(
    (child: unknown) => !previousChildren.has(child),
  );
}

function takeMatchingLocalUserEcho(instance: any, event: any) {
  if (event?.type !== "message_start") return undefined;
  const nextText = extractUserTextFromEvent(event);
  if (!nextText) return undefined;
  const queue = getLocalUserEchoQueue(instance);
  if (queue[0]?.text !== nextText) return undefined;
  return queue.shift();
}

function removeRenderedLocalUserEcho(instance: any, echo?: LocalUserEcho) {
  const container = instance?.chatContainer;
  if (!echo || typeof container?.removeChild !== "function") return;
  for (const child of echo.renderedChildren) {
    container.removeChild(child);
  }
}

function shouldIgnoreInteractiveSigint(instance: any) {
  return instance?.ui?.stopped === true;
}

type ClearableRenderState = {
  clear?(): void;
};

type RpcSessionRenderState = {
  chatContainer?: ClearableRenderState;
  pendingMessagesContainer?: ClearableRenderState;
  compactionQueuedMessages?: unknown[];
  streamingComponent?: unknown;
  streamingMessage?: unknown;
  pendingTools?: ClearableRenderState;
};

type RpcResyncHistoryRenderer = RpcSessionRenderState & {
  sessionManager: Pick<SessionManager, "buildContextEntries">;
  renderSessionEntries(
    entries: ReturnType<SessionManager["buildContextEntries"]>,
    options: { updateFooter: boolean; populateHistory: boolean },
  ): void;
};

function clearCurrentSessionRenderState(instance: RpcSessionRenderState) {
  instance.chatContainer?.clear?.();
  instance.pendingMessagesContainer?.clear?.();
  instance.compactionQueuedMessages = [];
  instance.streamingComponent = undefined;
  instance.streamingMessage = undefined;
  instance.pendingTools?.clear?.();
}

function redrawCurrentSessionHistoryAfterRpcResync(
  instance: RpcResyncHistoryRenderer,
) {
  clearCurrentSessionRenderState(instance);
  const entries = instance.sessionManager.buildContextEntries();
  instance.renderSessionEntries(entries, {
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
  runRecoverableRinTuiOperation(
    instance,
    "Failed to check for Rin updates",
    () => sleep(0).then(() => showRinUpdateNotificationWhenReady(instance)),
  );
}

function escapeRinGitChangelogMarkdownText(value: string) {
  return value.replace(/([\\`*_[\]<>])/g, "\\$1");
}

function formatRinGitChangelogMarkdown(notice: RinGitChangelogNotice) {
  return notice.commits
    .map((commit) => `- ${escapeRinGitChangelogMarkdownText(commit.subject)}`)
    .join("\n");
}

export function showRinGitChangelogNotification(
  instance: any,
  notice: RinGitChangelogNotice,
) {
  const chatContainer = instance?.chatContainer;
  if (
    !Array.isArray(chatContainer?.children) ||
    typeof chatContainer?.removeChild !== "function" ||
    typeof instance?.showStartupNoticesIfNeeded !== "function" ||
    typeof instance?.ui?.requestRender !== "function"
  ) {
    return false;
  }

  const previousMarkdown = instance.changelogMarkdown;
  const previousShown = instance.startupNoticesShown;
  const initialChildCount = chatContainer.children.length;
  const rollback = () => {
    const addedChildren = chatContainer.children.slice(initialChildCount);
    for (const child of [...addedChildren].reverse()) {
      chatContainer.removeChild(child);
    }
  };

  try {
    instance.changelogMarkdown = formatRinGitChangelogMarkdown(notice);
    instance.startupNoticesShown = false;
    instance.showStartupNoticesIfNeeded();
    if (chatContainer.children.length === initialChildCount) return false;
    if (instance.ui.requestRender() === false) {
      rollback();
      return false;
    }
    return true;
  } catch (error) {
    rollback();
    throw error;
  } finally {
    instance.changelogMarkdown = previousMarkdown;
    instance.startupNoticesShown = previousShown;
  }
}

export function canShowRinGitStartupChangelog(instance: any) {
  const sessionFile = instance?.sessionManager?.getSessionFile?.();
  if (sessionFile && existsSync(sessionFile)) return false;
  return (instance?.session?.state?.messages || []).length === 0;
}

function scheduleRinGitChangelogNotificationWhenReady(instance: any) {
  void sleep(0)
    .then(() => showRinGitChangelogNotificationWhenReady(instance))
    .catch(() => {
      // Git changelog checks are best-effort and must never block the TUI.
    });
}

async function showRinGitChangelogNotificationWhenReady(instance: any) {
  if (!canShowRinGitStartupChangelog(instance)) return;
  const settingsManager = instance?.settingsManager;
  await processRinGitStartupChangelog({
    lastVersion: settingsManager?.getLastChangelogVersion?.(),
    showNotice: async (notice) => {
      if (!canShowRinGitStartupChangelog(instance)) return false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (instance?.isInitialized) break;
        await sleep(50);
      }
      if (
        !instance?.isInitialized ||
        !canShowRinGitStartupChangelog(instance)
      ) {
        return false;
      }
      return showRinGitChangelogNotification(instance, notice);
    },
    setLastVersion: (version) =>
      settingsManager?.setLastChangelogVersion?.(version),
  });
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

  const currentRelease = readInstalledRinReleaseInfo();
  if (currentRelease?.channel === "git") return undefined;
  const currentVersion = getCurrentRinVersion(undefined, currentRelease);
  if (!parsePackageVersion(currentVersion)) return undefined;

  const settingsManager = instance?.settingsManager;
  const lastVersion = settingsManager?.getLastChangelogVersion?.();
  if (!String(lastVersion || "").trim()) {
    settingsManager?.setLastChangelogVersion?.(currentVersion);
    return undefined;
  }

  const entries = getRinStartupChangelogEntries(
    readRinChangelogEntries(),
    lastVersion,
    currentVersion,
  );
  if (entries.length > 0) {
    settingsManager?.setLastChangelogVersion?.(currentVersion);
    return entries.map((entry) => entry.content).join("\n\n");
  }
  if (
    !parsePackageVersion(lastVersion) ||
    comparePackageVersions(currentVersion, lastVersion) < 0
  ) {
    settingsManager?.setLastChangelogVersion?.(currentVersion);
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
  instance: any,
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
    runRecoverableRinTuiOperation(
      instance,
      "Failed to load more sessions",
      () => state.loadNext(selector, scope),
    );
  }
}

function attachSessionSelectorPagination(
  instance: any,
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
    maybeLoadNextSessionSelectorPage(instance, selector, states);
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
      scheduleRinGitChangelogNotificationWhenReady(this);
      for (const warning of this.options?.rinStartupWarnings || []) {
        if (warning) this.showWarning(warning);
      }
      runRecoverableRinTuiOperation(
        this,
        "Failed to check terminal keyboard support",
        () =>
          this.checkTmuxKeyboardSetup?.().then(
            (warning: string | undefined) => {
              if (warning) this.showWarning(warning);
            },
          ),
      );

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
      const modelsJsonError =
        this.session.modelRuntime?.getError?.() ||
        this.session.modelRegistry?.getError?.();
      if (modelsJsonError)
        this.showError(`models.json error: ${modelsJsonError}`);
      if (modelFallbackMessage) this.showWarning(modelFallbackMessage);
      runRecoverableRinTuiOperation(
        this,
        "Failed to check subscription authentication",
        () => this.maybeWarnAboutAnthropicSubscriptionAuth?.(),
      );

      if (initialMessage) {
        try {
          await this.session.prompt(initialMessage, { images: initialImages });
        } catch (error) {
          this.showError(formatRuntimeErrorForFrontendDisplay(error));
        }
      }
      if (initialMessages) {
        for (const message of initialMessages) {
          try {
            await this.session.prompt(message);
          } catch (error) {
            this.showError(formatRuntimeErrorForFrontendDisplay(error));
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
          this.showError(formatRuntimeErrorForFrontendDisplay(error));
        }
      }

      while (true) {
        const userInput = await this.getUserInput();
        try {
          await this.session.prompt(userInput);
        } catch (error) {
          this.showError(formatRuntimeErrorForFrontendDisplay(error));
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
    // Pi treats session-operation failures as fatal. Rin's daemon-backed TUI can
    // recover them, so keep the process and terminal alive. Transport loss is
    // already owned by the Connecting status; only other failures need an error.
    interactiveModeProto.handleFatalRuntimeError =
      function handleRecoverableRuntimeError(prefix: unknown, error: unknown) {
        reportRecoverableRinTuiError(this, prefix, error);
        return { cancelled: true };
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
              runRecoverableRinTuiOperation(
                this,
                "Failed to shut down the TUI",
                () => this.shutdown(),
              );
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
          attachSessionSelectorPagination(this, selector, pageStates);
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
      function subscribeToAgentWithRecoverableErrorBoundary() {
        const handleFailure = (error: unknown) => {
          let result: unknown;
          try {
            if (typeof this.handleFatalRuntimeError !== "function") {
              reportRecoverableRinTuiError(
                this,
                "Failed to handle session event",
                error,
              );
              return;
            }
            result = this.handleFatalRuntimeError(
              "Failed to handle session event",
              error,
            );
          } catch (reportingError) {
            reportRecoverableRinTuiError(
              this,
              "Failed to handle session event",
              error,
              reportingError,
            );
            return;
          }
          void Promise.resolve(result).catch((reportingError) => {
            reportRecoverableRinTuiError(
              this,
              "Failed to handle session event",
              error,
              reportingError,
            );
          });
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
        const localEcho: LocalUserEcho = {
          text,
          renderedChildren: [],
        };
        getLocalUserEchoQueue(this).push(localEcho);
        await renderLocalUserEcho(this, localEcho, originalHandleEvent);
        return;
      }

      if (event?.type === "rpc_session_resynced") {
        const localUserEchoes = [...getLocalUserEchoQueue(this)];
        if (typeof this.handleRuntimeSessionChange === "function") {
          await this.handleRuntimeSessionChange();
        }
        redrawCurrentSessionHistoryAfterRpcResync(this);
        for (const localEcho of localUserEchoes) {
          await renderLocalUserEcho(this, localEcho, originalHandleEvent);
        }
        syncRpcFrontendStatus(this);
        return;
      }

      removeRenderedLocalUserEcho(this, takeMatchingLocalUserEcho(this, event));

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
