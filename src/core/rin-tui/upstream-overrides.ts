import {
  DynamicBorder,
  FooterComponent,
  InteractiveMode,
  SessionManager,
  SessionSelectorComponent,
} from "@mariozechner/pi-coding-agent";
import {
  Loader,
  Markdown,
  ProcessTerminal,
  Spacer,
  Text,
  truncateToWidth,
} from "@mariozechner/pi-tui";

import {
  checkForNewRinVersion,
  getRinChangelogUrl,
  readRinChangelogEntries,
} from "../rin-lib/update-notices.js";
import { extractMessageText } from "../message-content.js";
import { listBoundSessions, renameBoundSession } from "../session/factory.js";

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
const RPC_TRANSPORT_STATUS_LOADER_KEY = "__rinRpcTransportStatusLoader";
const RPC_TRANSPORT_LOADER_PHASES = new Set([
  "starting",
  "connecting",
  "sending",
]);

function dim(text: string) {
  return `${ANSI_DIM}${text}${ANSI_RESET}`;
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

function stopRpcTransportStatusLoader(instance: any) {
  const loader = instance?.[RPC_TRANSPORT_STATUS_LOADER_KEY];
  if (!loader) return;
  loader.stop?.();
  if (statusContainerHasChild(instance, loader)) {
    instance.statusContainer.clear();
  }
  instance[RPC_TRANSPORT_STATUS_LOADER_KEY] = undefined;
}

function createRpcTransportStatusLoader(instance: any, label: string) {
  return new Loader(
    instance.ui,
    (spinner) => spinner,
    (text) => text,
    label,
  );
}

function showRpcTransportStatus(instance: any, event: any) {
  const phase = String(event?.phase || "");
  if (!RPC_TRANSPORT_LOADER_PHASES.has(phase)) {
    stopRpcTransportStatusLoader(instance);
    if (phase === "idle") instance?.ui?.requestRender?.();
    return;
  }

  const label = String(event?.label || phase || "Starting");
  let loader = instance?.[RPC_TRANSPORT_STATUS_LOADER_KEY];
  if (!loader) {
    loader = createRpcTransportStatusLoader(instance, label);
    instance[RPC_TRANSPORT_STATUS_LOADER_KEY] = loader;
  } else {
    loader.setMessage(label);
  }
  instance.statusContainer.clear();
  instance.statusContainer.addChild(loader);
  instance.ui.requestRender();
}

function reattachExistingPiLoader(instance: any) {
  // RPC transport status is not allowed to create its own working animation.
  // Pi's canonical agent/compaction/retry events own those loader lifetimes;
  // this only restores an existing Pi-owned loader after another Pi event
  // cleared the shared status container.
  stopRpcTransportStatusLoader(instance);
  if (!instance?.loadingAnimation) return;
  instance.statusContainer.clear();
  instance.statusContainer.addChild(instance.loadingAnimation);
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

function showRinUpdateNotification(instance: any, newVersion: string) {
  const text = [
    `Rin update available: ${newVersion}`,
    "Run: rin update",
    `Changelog: ${getRinChangelogUrl()}`,
  ].join("\n");
  if (typeof instance?.showWarning === "function") {
    instance.showWarning(text);
    return;
  }
  instance?.chatContainer?.addChild?.(new Spacer(1));
  instance?.chatContainer?.addChild?.(new Text(`Warning: ${text}`, 1, 0));
  instance?.ui?.requestRender?.();
}

async function showRinUpdateNotificationWhenReady(instance: any) {
  try {
    const newVersion = await checkForNewRinVersion();
    if (!newVersion) return;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (instance?.isInitialized) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    showRinUpdateNotification(instance, newVersion);
  } catch {
    // Update checks must never block the TUI.
  }
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

function renderRootSessionSelectorHeader(header: any, width: number) {
  const title = "Resume Session";
  const sortLabel =
    header?.sortMode === "threaded"
      ? "Threaded"
      : header?.sortMode === "recent"
        ? "Recent"
        : "Fuzzy";
  const nameLabel = header?.nameFilter === "all" ? "All" : "Named";
  const rightText = header?.loading
    ? `Loading ${header.loadProgress ? `${header.loadProgress.loaded}/${header.loadProgress.total}` : "..."}`
    : `Name: ${nameLabel}  Sort: ${sortLabel}`;
  const availableLeft = Math.max(0, width - rightText.length - 1);
  const left = truncateToWidth(title, availableLeft, "");
  const spacing = Math.max(1, width - left.length - rightText.length);

  let hintLine = 're:<pattern> regex · "phrase" exact';
  if (header?.confirmingDeletePath != null) {
    hintLine = "Delete session? enter to confirm · esc to cancel";
  } else if (header?.statusMessage?.message) {
    hintLine = String(header.statusMessage.message);
  }

  const pathState = header?.showPath ? "on" : "off";
  const actionLine = `sort · named · delete · path ${pathState}${header?.showRenameHint ? " · rename" : ""}`;
  return [
    `${left}${" ".repeat(spacing)}${rightText}`,
    truncateToWidth(hintLine, width, "…"),
    truncateToWidth(actionLine, width, "…"),
  ];
}

function configureRootSessionSelectorPresentation(selector: any) {
  if (!selector || typeof selector !== "object") return;

  if (selector.header && typeof selector.header.render === "function") {
    selector.header.render = function renderWithoutDirectoryScope(
      width: number,
    ) {
      return renderRootSessionSelectorHeader(this, width);
    };
  }

  if (typeof selector.toggleScope === "function") {
    selector.toggleScope = () => {
      selector.header?.setStatusMessage?.(null);
      selector.header?.setScope?.("current");
      selector.header?.requestRender?.();
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
      const lines = originalRender.call(this, width);
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

  const originalUpdateTerminalTitle = interactiveModeProto?.updateTerminalTitle;
  if (typeof originalUpdateTerminalTitle === "function") {
    interactiveModeProto.updateTerminalTitle =
      function updateTerminalTitleWithoutCwd() {
        const sessionName = this?.sessionManager?.getSessionName?.();
        this?.ui?.terminal?.setTitle?.(
          sessionName ? `π - ${sessionName}` : "π",
        );
      };
  }

  const originalRun = interactiveModeProto?.run;
  if (typeof originalRun === "function") {
    interactiveModeProto.run = async function runWithRinUpdateNotices() {
      await this.init();
      void showRinUpdateNotificationWhenReady(this);
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
      function skipAutomaticChangelogDisplay() {
        return undefined;
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
        this.renderCurrentSessionState();
        syncRpcPiLoader(this);
        this.ui.requestRender();
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

      stopRpcTransportStatusLoader(this);
      await originalHandleEvent.call(this, event);

      if (shouldReapplyRpcPiLoader) {
        syncRpcPiLoader(this);
      }
      if (shouldReapplyLocalPiLoader) {
        syncLocalPiLoader(this);
      }
    };
  }
}
