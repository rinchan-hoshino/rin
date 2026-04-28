import {
  FooterComponent,
  InteractiveMode,
  SessionManager,
  SessionSelectorComponent,
} from "@mariozechner/pi-coding-agent";
import { Loader, ProcessTerminal, truncateToWidth } from "@mariozechner/pi-tui";

import { extractMessageText } from "../message-content.js";
import { listBoundSessions, renameBoundSession } from "../session/factory.js";

let applied = false;
const ANSI_DIM = "\u001b[2m";
const ANSI_RESET = "\u001b[0m";
const CLEAR_SCROLLBACK_SEQUENCE = "\u001b[3J";
const PRESERVE_SCROLLBACK_PATCH = Symbol.for(
  "rin.tui.preserve_scrollback_full_redraw",
);

function dim(text: string) {
  return `${ANSI_DIM}${text}${ANSI_RESET}`;
}

function extractUserTextFromEvent(event: any) {
  const message = event?.message;
  if (!message || message.role !== "user") return "";
  return extractMessageText(message.content, { trim: true });
}

function ensureTransportLoader(instance: any, label?: string) {
  if (!label) {
    if (instance.loadingAnimation) {
      instance.loadingAnimation.stop();
      instance.loadingAnimation = undefined;
      instance.statusContainer.clear();
      instance.ui.requestRender();
    }
    return;
  }
  if (!instance.loadingAnimation) {
    instance.loadingAnimation = new Loader(
      instance.ui,
      (spinner) => spinner,
      (text) => dim(text),
      label,
    );
  } else {
    instance.loadingAnimation.setMessage(label);
  }
  instance.statusContainer.clear();
  instance.statusContainer.addChild(instance.loadingAnimation);
  instance.ui.requestRender();
}

function isRpcTransportControlled(instance: any) {
  return typeof instance?.session?.getFrontendStatusEvent === "function";
}

function isRpcCompactionStatus(instance: any, status: any) {
  return (
    status?.phase === "compacting" ||
    (status?.phase === "working" && instance?.session?.isCompacting)
  );
}

function getRpcTransportLabel(status: any) {
  if (!status || status.phase === "idle") return undefined;
  return `${String(status.label || "Working")}...`;
}

function reattachExistingTransportLoader(instance: any) {
  if (!instance?.loadingAnimation) return;
  instance.statusContainer.clear();
  instance.statusContainer.addChild(instance.loadingAnimation);
  instance.ui.requestRender();
}

function syncRpcTransportLoader(instance: any) {
  if (!isRpcTransportControlled(instance)) return;
  const status = instance.session.getFrontendStatusEvent?.();
  if (status?.phase === "working") {
    reattachExistingTransportLoader(instance);
    return;
  }
  if (isRpcCompactionStatus(instance, status)) return;
  ensureTransportLoader(instance, getRpcTransportLabel(status));
}

function syncLocalTransportLoader(instance: any) {
  if (isRpcTransportControlled(instance)) return;
  if (!instance?.session?.isStreaming) return;
  const currentLabel =
    typeof instance?.loadingAnimation?.message === "string"
      ? instance.loadingAnimation.message.trim()
      : "";
  const queuedLabel =
    typeof instance?.pendingWorkingMessage === "string"
      ? instance.pendingWorkingMessage.trim()
      : "";
  ensureTransportLoader(
    instance,
    currentLabel ||
      queuedLabel ||
      String(instance?.defaultWorkingMessage || "Working..."),
  );
}

function shouldIgnoreInteractiveSigint(instance: any) {
  return instance?.ui?.stopped === true;
}

function stripClearScrollback(data: string) {
  return data.includes(CLEAR_SCROLLBACK_SEQUENCE)
    ? data.split(CLEAR_SCROLLBACK_SEQUENCE).join("")
    : data;
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

function createSessionSelectorLoaders(instance: any) {
  const renameSessionIfNamed = async (
    rename: (sessionFilePath: string, nextName: string) => Promise<void> | void,
    sessionFilePath: string,
    nextName: string | undefined,
  ) => {
    const next = (nextName ?? "").trim();
    if (!next) return;
    await rename(sessionFilePath, next);
  };

  if (!isRpcTransportControlled(instance)) {
    const loadSessions = () =>
      listBoundSessions({
        cwd: instance.sessionManager.getCwd(),
        sessionDir: instance.sessionManager.getSessionDir(),
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
      if (!this.__rinLocalUserEchoQueue) this.__rinLocalUserEchoQueue = [];
      if (!this.isInitialized) {
        await this.init();
      }

      if (event?.type === "rpc_frontend_status") {
        if (event.phase === "working") {
          reattachExistingTransportLoader(this);
          return;
        }
        if (isRpcCompactionStatus(this, event)) return;
        ensureTransportLoader(this, getRpcTransportLabel(event));
        return;
      }

      if (event?.type === "rpc_local_user_message") {
        const text = String(event.text || "").trim();
        if (!text) return;
        this.__rinLocalUserEchoQueue.push(text);
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
        this.__rinLocalUserEchoQueue = [];
        if (typeof this.handleRuntimeSessionChange === "function") {
          await this.handleRuntimeSessionChange();
        }
        this.renderCurrentSessionState();
        syncRpcTransportLoader(this);
        this.ui.requestRender();
        return;
      }

      if (event?.type === "message_start" && extractUserTextFromEvent(event)) {
        const nextText = extractUserTextFromEvent(event);
        const queue = this.__rinLocalUserEchoQueue;
        if (Array.isArray(queue) && queue[0] === nextText) {
          queue.shift();
          return;
        }
      }

      const shouldReapplyRpcTransport =
        isRpcTransportControlled(this) &&
        (event?.type === "agent_end" ||
          event?.type === "compaction_end" ||
          event?.type === "auto_retry_start" ||
          event?.type === "auto_retry_end");
      const shouldReapplyLocalTransport =
        !isRpcTransportControlled(this) && event?.type === "compaction_end";

      await originalHandleEvent.call(this, event);

      if (shouldReapplyRpcTransport) {
        syncRpcTransportLoader(this);
      }
      if (shouldReapplyLocalTransport) {
        syncLocalTransportLoader(this);
      }
    };
  }
}
