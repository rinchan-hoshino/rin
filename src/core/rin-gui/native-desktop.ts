import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { buildGuiInstallerHtml } from "../rin-install/gui.js";
import type { RinDaemonFrontendClient } from "../rin-frontend-sdk/index.js";
import {
  buildDesktopHostLaunch,
  type DesktopHostLaunch,
} from "./host-launch.js";

export type NativeDesktopHostLaunch = DesktopHostLaunch;

export type ElectronDesktopHostSurface = "chat" | "installer";

export function buildNativeDesktopHostLaunch(
  env: NodeJS.ProcessEnv = process.env,
): NativeDesktopHostLaunch {
  return buildDesktopHostLaunch(env, ["RIN_GUI_NATIVE_HOST"], ["--stdio"]);
}

function frontendEventText(event: any) {
  if (!event || typeof event !== "object") return "";
  if (event.type === "status") return String(event.text || "");
  if (event.type === "message_delta") return String(event.delta || "");
  if (event.type === "tool") {
    const title = event.title || event.toolName || "tool";
    const body = event.body ? `\n${event.body}` : "";
    return `${title}${body}`;
  }
  if (event.type === "session_changed") {
    return event.title
      ? `Session: ${String(event.title)}`
      : `Session changed: ${String(event.sessionId || "")}`;
  }
  const payload = event.payload || event;
  if (typeof payload.delta === "string") return payload.delta;
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.message === "string") return payload.message;
  return JSON.stringify(payload);
}

function nativeEventRole(event: any) {
  if (event?.type === "status") return "system";
  if (event?.type === "message_delta") return event.role || "assistant";
  if (event?.type === "tool") return "tool";
  return event?.type || "system";
}

function sendNativeEvent(stdin: NodeJS.WritableStream, payload: unknown) {
  stdin.write(`${JSON.stringify(payload)}\n`);
}

async function handleNativeDesktopCommand(
  command: any,
  client: RinDaemonFrontendClient,
  stdin: NodeJS.WritableStream,
) {
  if (command?.type === "prompt") {
    await client.submit(String(command.text || ""));
    return;
  }
  if (command?.type === "abort") {
    await client.abort();
    return;
  }
  if (command?.type === "close") return "close";
  if (command?.type === "sessions:list") {
    sendNativeEvent(stdin, {
      type: "sessions:list",
      sessions: await client.listSessions(),
    });
    return;
  }
  if (command?.type === "session:resume") {
    const sessionId = String(command.sessionId || "");
    if (!sessionId) throw new Error("rin_native_gui_missing_session");
    await client.resumeSession(sessionId);
    sendNativeEvent(stdin, { type: "session:resumed", sessionId });
    sendNativeEvent(stdin, {
      type: "sessions:list",
      sessions: await client.listSessions(),
    });
    return;
  }
  if (command?.type === "models:list") {
    sendNativeEvent(stdin, {
      type: "models:list",
      models: await client.listModels(),
    });
    return;
  }
  if (command?.type === "commands:list") {
    sendNativeEvent(stdin, {
      type: "commands:list",
      commands: await client.getCommands(),
    });
    return;
  }
  if (command?.type === "autocomplete:list") {
    sendNativeEvent(stdin, {
      type: "autocomplete:list",
      items: await client.getAutocompleteItems(String(command.input || "")),
    });
    return;
  }
  if (command?.type === "dialog:open") {
    sendNativeEvent(stdin, {
      type: "dialog:open",
      dialog: (await client.openDialog?.(String(command.id || ""))) || null,
    });
    return;
  }
  if (command?.type === "dialog:respond") {
    await client.respondDialog?.(String(command.id || ""), command.payload);
    sendNativeEvent(stdin, { type: "dialog:respond", ok: true });
    return;
  }
  throw new Error(
    `rin_native_gui_unknown_command:${String(command?.type || "")}`,
  );
}

export async function runNativeDesktopGui(options: {
  client: RinDaemonFrontendClient;
  env?: NodeJS.ProcessEnv;
}) {
  const launch = buildNativeDesktopHostLaunch(options.env);
  const child = spawn(launch.command, launch.args, {
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: false,
  });

  const client = options.client;
  const unsubscribe = client.subscribe((event) => {
    sendNativeEvent(child.stdin, {
      type: event.type === "status" ? "status" : "message",
      role: nativeEventRole(event),
      text: frontendEventText(event),
      event,
    });
  });

  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      void (async () => {
        let command: any;
        try {
          command = JSON.parse(line);
        } catch {
          return;
        }
        const result = await handleNativeDesktopCommand(
          command,
          client,
          child.stdin,
        );
        if (result === "close") child.kill();
      })().catch((error) => {
        sendNativeEvent(child.stdin, {
          type: "status",
          text: String(
            error?.message || error || "rin_native_gui_command_failed",
          ),
        });
      });
    }
  });

  sendNativeEvent(child.stdin, {
    type: "status",
    text: "Connected to local Rin daemon",
  });
  sendNativeEvent(child.stdin, {
    type: "surface:ready",
    capabilities: [
      "prompt",
      "abort",
      "sessions",
      "session-resume",
      "models",
      "commands",
      "autocomplete",
      "dialogs",
    ],
  });

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  }).finally(() => {
    unsubscribe();
    try {
      child.stdin.end();
    } catch {}
  });
}

export function buildElectronDesktopHostPreloadScript() {
  return `const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rinDesktop', {
  send(command) {
    ipcRenderer.send('rin-command', command);
  },
  onEvent(callback) {
    ipcRenderer.on('rin-event', (_event, payload) => callback(payload));
  }
});
`;
}

function buildChatDesktopHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' data:; script-src 'self' 'unsafe-inline';" />
  <title>Rin</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    main { display: grid; grid-template-columns: 300px 1fr; height: 100vh; }
    aside { border-right: 1px solid color-mix(in srgb, CanvasText 18%, transparent); overflow: auto; padding: 14px; }
    .workspace { display: grid; grid-template-rows: auto 1fr auto; min-width: 0; }
    header { padding: 12px 16px; border-bottom: 1px solid color-mix(in srgb, CanvasText 18%, transparent); }
    h1 { margin: 0; font-size: 18px; }
    h2 { font-size: 13px; margin: 18px 0 8px; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.72; }
    #status { font-size: 12px; opacity: 0.72; margin-top: 4px; }
    #messages { overflow: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
    .message { border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 10px; padding: 10px 12px; white-space: pre-wrap; max-width: min(760px, 88%); }
    .message.user { align-self: flex-end; background: color-mix(in srgb, Highlight 14%, Canvas); }
    .message.assistant, .message.message_delta { align-self: flex-start; background: color-mix(in srgb, CanvasText 5%, Canvas); }
    .message.tool { align-self: flex-start; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .message.system { align-self: center; font-size: 12px; opacity: 0.72; }
    form { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; padding: 12px 16px; border-top: 1px solid color-mix(in srgb, CanvasText 18%, transparent); }
    textarea { resize: vertical; min-height: 44px; max-height: 30vh; border-radius: 8px; padding: 10px; font: inherit; }
    button { border-radius: 8px; padding: 8px 12px; font: inherit; cursor: pointer; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .list { display: grid; gap: 6px; }
    .item { border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 10px; padding: 8px; background: Canvas; text-align: left; }
    .item.active { border-color: Highlight; background: color-mix(in srgb, Highlight 10%, Canvas); }
    .item-title { font-weight: 650; }
    .item-subtitle { font-size: 12px; opacity: 0.68; margin-top: 2px; }
    .empty { font-size: 12px; opacity: 0.62; }
  </style>
</head>
<body>
  <main>
    <aside>
      <h1>Rin</h1>
      <div id="status">Connected to local Rin daemon</div>
      <div class="toolbar">
        <button id="refresh-runtime" type="button">Refresh runtime</button>
      </div>
      <h2>Sessions</h2>
      <div id="sessions" class="list"><div class="empty">Loading sessions…</div></div>
      <h2>Models</h2>
      <div id="models" class="list"><div class="empty">Loading models…</div></div>
      <h2>Commands</h2>
      <div id="commands" class="list"><div class="empty">Loading commands…</div></div>
    </aside>
    <section class="workspace">
      <header>
        <h1>Chat</h1>
        <div class="toolbar" aria-label="Runtime controls">
          <button id="refresh-sessions" type="button">Sessions</button>
          <button id="refresh-models" type="button">Models</button>
          <button id="refresh-commands" type="button">Commands</button>
        </div>
      </header>
      <section id="messages" aria-live="polite"></section>
      <form id="prompt-form">
        <textarea id="prompt" placeholder="Ask Rin, use /commands, or resume a session from the sidebar…" autofocus></textarea>
        <button type="submit">Send</button>
        <button id="abort" type="button">Abort</button>
      </form>
    </section>
  </main>
  <script>
    const statusEl = document.getElementById('status');
    const messagesEl = document.getElementById('messages');
    const form = document.getElementById('prompt-form');
    const promptEl = document.getElementById('prompt');
    const abortEl = document.getElementById('abort');
    const sessionsEl = document.getElementById('sessions');
    const modelsEl = document.getElementById('models');
    const commandsEl = document.getElementById('commands');

    function send(command) { window.rinDesktop.send(command); }

    function appendMessage(role, text) {
      if (!text) return;
      const node = document.createElement('div');
      node.className = 'message ' + (role || 'system');
      node.textContent = text;
      messagesEl.appendChild(node);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function empty(text) {
      const node = document.createElement('div');
      node.className = 'empty';
      node.textContent = text;
      return node;
    }

    function item(title, subtitle, onClick, active) {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = 'item' + (active ? ' active' : '');
      const titleEl = document.createElement('div');
      titleEl.className = 'item-title';
      titleEl.textContent = title;
      node.appendChild(titleEl);
      if (subtitle) {
        const subtitleEl = document.createElement('div');
        subtitleEl.className = 'item-subtitle';
        subtitleEl.textContent = subtitle;
        node.appendChild(subtitleEl);
      }
      node.addEventListener('click', onClick);
      return node;
    }

    function renderSessions(sessions) {
      const values = Array.isArray(sessions) ? sessions : [];
      sessionsEl.replaceChildren(...(values.length ? values.map((session) => item(
        session.title || session.id || 'Session',
        session.subtitle || session.id || '',
        () => send({ type: 'session:resume', sessionId: session.id }),
        Boolean(session.isActive)
      )) : [empty('No sessions found')]));
    }

    function renderModels(models) {
      const values = Array.isArray(models) ? models : [];
      modelsEl.replaceChildren(...(values.length ? values.slice(0, 8).map((model) => item(
        model.label || model.id || 'Model',
        [model.provider, model.description].filter(Boolean).join(' · '),
        () => appendMessage('system', 'Model available: ' + (model.label || model.id || 'model')),
        false
      )) : [empty('No models reported')]));
    }

    function renderCommands(commands) {
      const values = Array.isArray(commands) ? commands : [];
      commandsEl.replaceChildren(...(values.length ? values.slice(0, 12).map((command) => item(
        command.name || command.id || '/command',
        command.description || command.category || '',
        () => {
          const name = command.name || command.id || '';
          promptEl.value = name.startsWith('/') ? name + ' ' : '/' + name + ' ';
          promptEl.focus();
        },
        false
      )) : [empty('No commands available')]));
    }

    function refreshRuntime() {
      send({ type: 'sessions:list' });
      send({ type: 'models:list' });
      send({ type: 'commands:list' });
    }

    window.rinDesktop.onEvent((payload) => {
      if (payload.type === 'status') statusEl.textContent = payload.text || 'Status';
      else if (payload.type === 'surface:ready') refreshRuntime();
      else if (payload.type === 'sessions:list') renderSessions(payload.sessions);
      else if (payload.type === 'session:resumed') appendMessage('system', 'Resumed session: ' + payload.sessionId);
      else if (payload.type === 'models:list') renderModels(payload.models);
      else if (payload.type === 'commands:list') renderCommands(payload.commands);
      else appendMessage(payload.role || payload.type, payload.text || JSON.stringify(payload));
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = promptEl.value.trim();
      if (!text) return;
      appendMessage('user', text);
      promptEl.value = '';
      send({ type: 'prompt', text });
    });
    abortEl.addEventListener('click', () => send({ type: 'abort' }));
    document.getElementById('refresh-runtime').addEventListener('click', refreshRuntime);
    document.getElementById('refresh-sessions').addEventListener('click', () => send({ type: 'sessions:list' }));
    document.getElementById('refresh-models').addEventListener('click', () => send({ type: 'models:list' }));
    document.getElementById('refresh-commands').addEventListener('click', () => send({ type: 'commands:list' }));
    refreshRuntime();
  </script>
</body>
</html>`;
}

function htmlForSurface(surface: ElectronDesktopHostSurface) {
  if (surface === "installer") return buildGuiInstallerHtml();
  return buildChatDesktopHtml();
}

export function buildElectronDesktopHostMainScript(options: {
  preloadPath: string;
  title?: string;
  surface?: ElectronDesktopHostSurface;
}) {
  const surface = options.surface || "chat";
  const title = JSON.stringify(
    options.title || (surface === "installer" ? "Rin Installer" : "Rin"),
  );
  const preloadPath = JSON.stringify(options.preloadPath);
  const html = JSON.stringify(htmlForSurface(surface));
  return `const { app, BrowserWindow, ipcMain } = require('electron');
const readline = require('node:readline');

let mainWindow = null;
const queuedEvents = [];

function sendCommand(command) {
  process.stdout.write(JSON.stringify(command) + '\\n');
}

function postEvent(payload) {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) {
    queuedEvents.push(payload);
    return;
  }
  mainWindow.webContents.send('rin-event', payload);
}

function flushEvents() {
  while (queuedEvents.length > 0) postEvent(queuedEvents.shift());
}

function html() {
  return ${html};
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    title: ${title},
    webPreferences: {
      preload: ${preloadPath},
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html()));
  mainWindow.webContents.once('did-finish-load', flushEvents);
  mainWindow.on('closed', () => {
    sendCommand({ type: 'close' });
    mainWindow = null;
  });
}

ipcMain.on('rin-command', (_event, command) => sendCommand(command));

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  try { postEvent(JSON.parse(line)); } catch {}
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
`;
}

export function createElectronDesktopHostFiles(
  options: { title?: string; surface?: ElectronDesktopHostSurface } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-electron-host-"));
  const preloadPath = path.join(dir, "preload.cjs");
  const mainPath = path.join(dir, "main.cjs");
  fs.writeFileSync(
    preloadPath,
    buildElectronDesktopHostPreloadScript(),
    "utf8",
  );
  fs.writeFileSync(
    mainPath,
    buildElectronDesktopHostMainScript({
      preloadPath,
      title: options.title,
      surface: options.surface,
    }),
    "utf8",
  );
  return { dir, mainPath, preloadPath };
}

export async function runElectronDesktopHost(options: {
  args?: string[];
  electronBinary: string;
  title?: string;
}) {
  const args = options.args || [];
  let surface: ElectronDesktopHostSurface = "chat";
  for (const arg of args) {
    if (arg === "--stdio") continue;
    if (arg === "--installer") {
      surface = "installer";
      continue;
    }
    throw new Error(`rin_desktop_host_unknown_arg:${arg}`);
  }
  const { dir, mainPath } = createElectronDesktopHostFiles({
    title: options.title,
    surface,
  });
  const child = spawn(options.electronBinary, [mainPath], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  }).finally(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
}
