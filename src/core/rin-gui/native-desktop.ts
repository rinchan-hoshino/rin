import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildGuiInstallerHtml } from "../rin-install/gui.js";
import type { RinDaemonFrontendClient } from "../rin-frontend-sdk/index.js";
import {
  buildDesktopHostLaunch,
  type DesktopHostLaunch,
} from "./host-launch.js";

export type NativeDesktopHostLaunch = DesktopHostLaunch;

export type ElectronDesktopHostSurface = "assistant" | "chat" | "installer";

export type NativeDesktopSettings = {
  provider?: string;
  model?: string;
  thinking?: string;
};

function runtimeDesktopHostEntry() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "app",
    "rin-desktop-host",
    "main.js",
  );
}

function defaultDesktopHostCommand() {
  const entry = runtimeDesktopHostEntry();
  return fs.existsSync(entry)
    ? `${process.execPath} ${entry}`
    : "rin-desktop-host";
}

export function buildNativeDesktopHostLaunch(
  env: NodeJS.ProcessEnv = process.env,
): NativeDesktopHostLaunch {
  return buildDesktopHostLaunch(
    env,
    ["RIN_GUI_NATIVE_HOST"],
    ["--stdio", "--assistant"],
    defaultDesktopHostCommand(),
  );
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

function normalizeSettings(value: unknown): NativeDesktopSettings {
  const record = value && typeof value === "object" ? (value as any) : {};
  return {
    provider: String(record.provider || "").trim(),
    model: String(record.model || "").trim(),
    thinking: String(record.thinking || "").trim(),
  };
}

function readNativeSettings(settingsPath?: string): NativeDesktopSettings {
  if (!settingsPath) return {};
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(settingsPath, "utf8")));
  } catch {
    return {};
  }
}

function saveNativeSettings(
  settingsPath: string | undefined,
  patch: NativeDesktopSettings,
) {
  if (!settingsPath) throw new Error("rin_native_gui_settings_path_missing");
  let current: Record<string, any> = {};
  try {
    current = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {}
  const next = { ...current };
  for (const key of ["provider", "model", "thinking"] as const) {
    const value = String(patch[key] || "").trim();
    if (value) next[key] = value;
    else delete next[key];
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return normalizeSettings(next);
}

async function handleNativeDesktopCommand(
  command: any,
  options: {
    client: RinDaemonFrontendClient;
    stdin: NodeJS.WritableStream;
    settingsPath?: string;
  },
) {
  const { client, stdin, settingsPath } = options;
  if (command?.type === "prompt") {
    await client.submit(String(command.text || ""));
    return;
  }
  if (command?.type === "abort") {
    await client.abort();
    return;
  }
  if (command?.type === "close") return "close";
  if (command?.type === "settings:get") {
    sendNativeEvent(stdin, {
      type: "settings:get",
      settings: readNativeSettings(settingsPath),
    });
    return;
  }
  if (command?.type === "settings:save") {
    sendNativeEvent(stdin, {
      type: "settings:saved",
      settings: saveNativeSettings(settingsPath, command.settings || {}),
    });
    return;
  }
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
  if (command?.type === "builtin-extensions:list") {
    sendNativeEvent(stdin, {
      type: "builtin-extensions:list",
      extensions: await client.listBuiltInExtensions(),
    });
    return;
  }
  if (command?.type === "builtin-extensions:set") {
    const extensionId = String(command.extensionId || "");
    if (!extensionId) throw new Error("Missing built-in extension id.");
    const extension = await client.setBuiltInExtension(
      extensionId,
      Boolean(command.enabled),
    );
    sendNativeEvent(stdin, { type: "builtin-extensions:set", extension });
    sendNativeEvent(stdin, {
      type: "builtin-extensions:list",
      extensions: await client.listBuiltInExtensions(),
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
  settingsPath?: string;
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
        const result = await handleNativeDesktopCommand(command, {
          client,
          stdin: child.stdin,
          settingsPath: options.settingsPath,
        });
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
    settings: readNativeSettings(options.settingsPath),
    capabilities: [
      "prompt",
      "abort",
      "settings",
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
  setMode(mode) {
    ipcRenderer.send('rin-window-mode', mode);
  },
  onEvent(callback) {
    ipcRenderer.on('rin-event', (_event, payload) => callback(payload));
  }
});
`;
}

function buildAssistantDesktopHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' data:; script-src 'self' 'unsafe-inline';" />
  <title>Rin</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; overflow: hidden; background: transparent; color: CanvasText; }
    button, textarea, input, select { font: inherit; }
    #pet { width: 76px; height: 76px; border: 0; border-radius: 24px; display: grid; place-items: center; cursor: pointer; color: white; background: linear-gradient(135deg, #ffb6d5, #ff8fb8 48%, #f6c56f); box-shadow: 0 14px 36px rgba(0,0,0,.28); font-size: 36px; user-select: none; }
    #pet::before { content: 'Rin'; position: absolute; bottom: 9px; font-size: 11px; font-weight: 700; letter-spacing: .04em; }
    #chat, #settings { position: fixed; right: 0; bottom: 0; width: min(430px, 100vw); height: min(640px, 100vh); background: Canvas; border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 18px; box-shadow: 0 18px 54px rgba(0,0,0,.32); overflow: hidden; display: none; }
    body.chat #chat, body.settings #settings { display: grid; }
    #chat { grid-template-rows: auto 1fr auto; }
    #settings { grid-template-rows: auto 1fr; }
    header { padding: 12px 14px; border-bottom: 1px solid color-mix(in srgb, CanvasText 14%, transparent); display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    h1 { margin: 0; font-size: 16px; }
    .toolbar { display: flex; gap: 6px; flex-wrap: wrap; }
    .toolbar button, form button { border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 9px; background: Canvas; color: CanvasText; padding: 6px 9px; cursor: pointer; }
    #status { font-size: 12px; opacity: .68; }
    #messages { overflow: auto; padding: 14px; display: flex; flex-direction: column; gap: 9px; }
    .message { border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius: 12px; padding: 9px 11px; white-space: pre-wrap; max-width: 86%; }
    .message.user { align-self: flex-end; background: color-mix(in srgb, Highlight 14%, Canvas); }
    .message.assistant, .message.message_delta { align-self: flex-start; background: color-mix(in srgb, CanvasText 5%, Canvas); }
    .message.tool { align-self: flex-start; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .message.system { align-self: center; font-size: 12px; opacity: .72; }
    form { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; padding: 12px; border-top: 1px solid color-mix(in srgb, CanvasText 14%, transparent); }
    textarea { resize: none; min-height: 42px; max-height: 30vh; border-radius: 10px; padding: 10px; }
    .panel { overflow: auto; padding: 14px; display: grid; gap: 12px; align-content: start; }
    label { display: grid; gap: 5px; font-size: 13px; }
    input, select { border-radius: 8px; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); background: Canvas; color: CanvasText; padding: 8px; }
    .list { display: grid; gap: 6px; }
    .item { border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 10px; padding: 8px; background: Canvas; text-align: left; color: CanvasText; cursor: pointer; }
    .item-subtitle { font-size: 12px; opacity: .68; margin-top: 2px; }
  </style>
</head>
<body>
  <button id="pet" title="Open Rin">♪</button>
  <section id="chat">
    <header><div><h1>Rin desktop assistant</h1><div id="status">Starting…</div></div><div class="toolbar"><button id="open-settings" type="button">Settings</button><button id="close-chat" type="button">Hide</button></div></header>
    <section id="messages" aria-live="polite"></section>
    <form id="prompt-form"><textarea id="prompt" placeholder="Ask Rin…"></textarea><button type="submit">Send</button><button id="abort" type="button">Abort</button></form>
  </section>
  <section id="settings">
    <header><h1>Settings</h1><div class="toolbar"><button id="close-settings" type="button">Back</button></div></header>
    <div class="panel">
      <label>Provider<input id="setting-provider" placeholder="openai" /></label>
      <label>Model<input id="setting-model" placeholder="provider/model" /></label>
      <label>Thinking<select id="setting-thinking"><option value="">Default</option><option>off</option><option>minimal</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option><option>max</option></select></label>
      <div class="toolbar"><button id="save-settings" type="button">Save settings</button><button id="refresh-runtime" type="button">Refresh runtime</button></div>
      <h2>Built-In Extensions</h2><div id="builtin-extensions" class="list"></div>
      <h2>Sessions</h2><div id="sessions" class="list"></div>
      <h2>Models</h2><div id="models" class="list"></div>
      <h2>Commands</h2><div id="commands" class="list"></div>
    </div>
  </section>
  <script>
    const body = document.body;
    const statusEl = document.getElementById('status');
    const messagesEl = document.getElementById('messages');
    const form = document.getElementById('prompt-form');
    const promptEl = document.getElementById('prompt');
    const sessionsEl = document.getElementById('sessions');
    const modelsEl = document.getElementById('models');
    const commandsEl = document.getElementById('commands');
    const builtInExtensionsEl = document.getElementById('builtin-extensions');
    const settingProvider = document.getElementById('setting-provider');
    const settingModel = document.getElementById('setting-model');
    const settingThinking = document.getElementById('setting-thinking');
    function send(command) { window.rinDesktop.send(command); }
    function show(mode) { body.className = mode || ''; window.rinDesktop.setMode(mode || 'icon'); if (mode === 'chat') promptEl.focus(); }
    function appendMessage(role, text) {
      if (!text) return;
      const node = document.createElement('div');
      node.className = 'message ' + (role || 'system');
      node.textContent = text;
      messagesEl.appendChild(node);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    function item(title, subtitle, onClick) {
      const node = document.createElement('button');
      node.type = 'button'; node.className = 'item'; node.textContent = title;
      if (subtitle) { const sub = document.createElement('div'); sub.className = 'item-subtitle'; sub.textContent = subtitle; node.appendChild(sub); }
      node.addEventListener('click', onClick); return node;
    }
    function setSettings(settings) {
      const value = settings || {};
      settingProvider.value = value.provider || '';
      settingModel.value = value.model || '';
      settingThinking.value = value.thinking || '';
    }
    function renderSessions(sessions) {
      const values = Array.isArray(sessions) ? sessions : [];
      sessionsEl.replaceChildren(...(values.length ? values.map((session) => item(session.title || session.id || 'Session', session.subtitle || session.id || '', () => send({ type: 'session:resume', sessionId: session.id }))) : [item('No sessions found', '', () => {})]));
    }
    function renderModels(models) {
      const values = Array.isArray(models) ? models : [];
      modelsEl.replaceChildren(...(values.length ? values.slice(0, 8).map((model) => item(model.label || model.id || 'Model', [model.provider, model.description].filter(Boolean).join(' · '), () => { settingModel.value = model.id || settingModel.value; if (model.provider) settingProvider.value = model.provider; } )) : [item('No models reported', '', () => {})]));
    }
    function renderCommands(commands) {
      const values = Array.isArray(commands) ? commands : [];
      commandsEl.replaceChildren(...(values.length ? values.slice(0, 12).map((command) => item(command.name || command.id || '/command', command.description || command.category || '', () => { const name = command.name || command.id || ''; show('chat'); promptEl.value = name.startsWith('/') ? name + ' ' : '/' + name + ' '; promptEl.focus(); } )) : [item('No commands available', '', () => {})]));
    }
    function renderBuiltInExtensions(extensions) {
      const values = Array.isArray(extensions) ? extensions : [];
      builtInExtensionsEl.replaceChildren(...(values.length ? values.map((extension) => {
        const enabled = Boolean(extension.enabled);
        const lifecycle = extension.lifecycle || {};
        const subtitle = [extension.description, enabled ? 'Enabled' : 'Disabled', lifecycle.status, lifecycle.detail].filter(Boolean).join(' · ');
        return item((enabled ? 'Disable ' : 'Enable ') + (extension.label || extension.id), subtitle, () => {
          builtInExtensionsEl.replaceChildren(item('Working…', extension.label || extension.id, () => {}));
          send({ type: 'builtin-extensions:set', extensionId: extension.id, enabled: !enabled });
        });
      }) : [item('No built-in extensions available', '', () => {})]));
    }
    function refreshRuntime() { send({ type: 'settings:get' }); send({ type: 'builtin-extensions:list' }); send({ type: 'sessions:list' }); send({ type: 'models:list' }); send({ type: 'commands:list' }); }
    window.rinDesktop.onEvent((payload) => {
      if (payload.type === 'status') statusEl.textContent = payload.text || 'Status';
      else if (payload.type === 'surface:ready') { setSettings(payload.settings); refreshRuntime(); }
      else if (payload.type === 'settings:get' || payload.type === 'settings:saved') { setSettings(payload.settings); if (payload.type === 'settings:saved') appendMessage('system', 'Settings saved. Restart long-running frontends if the model did not change immediately.'); }
      else if (payload.type === 'sessions:list') renderSessions(payload.sessions);
      else if (payload.type === 'session:resumed') { show('chat'); appendMessage('system', 'Resumed session: ' + payload.sessionId); }
      else if (payload.type === 'models:list') renderModels(payload.models);
      else if (payload.type === 'commands:list') renderCommands(payload.commands);
      else if (payload.type === 'builtin-extensions:list') renderBuiltInExtensions(payload.extensions);
      else if (payload.type === 'builtin-extensions:set') appendMessage('system', 'Built-In Extensions updated.');
      else { show('chat'); appendMessage(payload.role || payload.type, payload.text || JSON.stringify(payload)); }
    });
    document.getElementById('pet').addEventListener('click', () => show(body.className === 'chat' ? '' : 'chat'));
    document.getElementById('open-settings').addEventListener('click', () => show('settings'));
    document.getElementById('close-chat').addEventListener('click', () => show(''));
    document.getElementById('close-settings').addEventListener('click', () => show('chat'));
    document.getElementById('refresh-runtime').addEventListener('click', refreshRuntime);
    document.getElementById('save-settings').addEventListener('click', () => send({ type: 'settings:save', settings: { provider: settingProvider.value, model: settingModel.value, thinking: settingThinking.value } }));
    form.addEventListener('submit', (event) => { event.preventDefault(); const text = promptEl.value.trim(); if (!text) return; appendMessage('user', text); promptEl.value = ''; send({ type: 'prompt', text }); });
    document.getElementById('abort').addEventListener('click', () => send({ type: 'abort' }));
    refreshRuntime();
  </script>
</body>
</html>`;
}

function htmlForSurface(surface: ElectronDesktopHostSurface) {
  if (surface === "installer") return buildGuiInstallerHtml();
  return buildAssistantDesktopHtml();
}

export function buildElectronDesktopHostMainScript(options: {
  preloadPath: string;
  title?: string;
  surface?: ElectronDesktopHostSurface;
}) {
  const surface = options.surface || "assistant";
  const title = JSON.stringify(
    options.title || (surface === "installer" ? "Rin Installer" : "Rin"),
  );
  const preloadPath = JSON.stringify(options.preloadPath);
  const html = JSON.stringify(htmlForSurface(surface));
  const assistantMode = surface === "assistant";
  const width = assistantMode ? 76 : 980;
  const height = assistantMode ? 76 : 720;
  const minWidth = assistantMode ? 76 : 720;
  const minHeight = assistantMode ? 76 : 480;
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
    width: ${width},
    height: ${height},
    minWidth: ${minWidth},
    minHeight: ${minHeight},
    title: ${title},
    alwaysOnTop: ${assistantMode},
    frame: ${!assistantMode},
    transparent: ${assistantMode},
    resizable: true,
    skipTaskbar: ${assistantMode},
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
ipcMain.on('rin-window-mode', (_event, mode) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mode === 'chat' || mode === 'settings') {
    mainWindow.setSize(430, 640);
    mainWindow.setMinimumSize(360, 420);
    return;
  }
  mainWindow.setMinimumSize(76, 76);
  mainWindow.setSize(76, 76);
});

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
  let surface: ElectronDesktopHostSurface = "assistant";
  for (const arg of args) {
    if (arg === "--stdio") continue;
    if (arg === "--assistant") {
      surface = "assistant";
      continue;
    }
    if (arg === "--chat") {
      surface = "chat";
      continue;
    }
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
