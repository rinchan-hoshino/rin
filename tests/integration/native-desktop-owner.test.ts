import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fssync from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const desktop = await import(
  pathToFileURL(path.resolve("dist/core/rin-gui/native-desktop.js")).href
);

const hostScript = String.raw`
const fs = require("node:fs");
const commands = [
  { type: "prompt", text: "owner prompt" },
  { type: "abort" },
  { type: "settings:get" },
  { type: "settings:save", settings: { provider: " owner ", model: "owner/model", thinking: "high", language: "zh_CN" } },
  { type: "settings:save", settings: { provider: "", model: "", thinking: "", language: "" } },
  { type: "sessions:list" },
  { type: "session:resume", sessionId: "" },
  { type: "session:resume", sessionId: "owner-session" },
  { type: "models:list" },
  { type: "commands:list" },
  { type: "builtin-extensions:list" },
  { type: "builtin-extensions:set", extensionId: "" },
  { type: "builtin-extensions:set", extensionId: "owner-extension", enabled: true },
  { type: "builtin-extensions:set", extensionId: "owner-extension" },
  { type: "autocomplete:list", input: "/ow" },
  { type: "autocomplete:list" },
  { type: "dialog:open", id: "owner-dialog" },
  { type: "dialog:open", id: "" },
  { type: "dialog:respond", id: "owner-dialog", payload: { accepted: true } },
  { type: "unknown-owner" },
  {},
];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => fs.appendFileSync(process.env.RIN_OWNER_NATIVE_CAPTURE, chunk));
process.stdout.write("not-json\n\n");
let index = 0;
const timer = setInterval(() => {
  if (index < commands.length) {
    process.stdout.write(JSON.stringify(commands[index++]) + "\n");
    return;
  }
  clearInterval(timer);
  setTimeout(() => process.stdout.write(JSON.stringify({ type: "close" }) + "\n"), 80);
}, 15);
setInterval(() => {}, 1000);
`;

test("native desktop owns host protocol, settings, generated Electron surfaces, and lifecycle", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-native-desktop-owner-"),
  );
  const scriptPath = path.join(root, "owner-host.cjs");
  const capturePath = path.join(root, "capture.jsonl");
  const settingsPath = path.join(root, "settings", "native.json");
  await fs.writeFile(scriptPath, hostScript, "utf8");
  await fs.writeFile(capturePath, "", "utf8");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, "not-json", "utf8");

  const oldCapture = process.env.RIN_OWNER_NATIVE_CAPTURE;
  process.env.RIN_OWNER_NATIVE_CAPTURE = capturePath;
  try {
    const explicitLaunch = desktop.buildNativeDesktopHostLaunch({
      RIN_GUI_NATIVE_HOST: `${process.execPath} ${scriptPath}`,
    });
    assert.equal(explicitLaunch.command, process.execPath);
    assert.deepEqual(explicitLaunch.args, [
      scriptPath,
      "--stdio",
      "--assistant",
    ]);
    const defaultLaunch = desktop.buildNativeDesktopHostLaunch({});
    assert.equal(defaultLaunch.args.includes("--stdio"), true);
    assert.equal(defaultLaunch.args.includes("--assistant"), true);

    const clientCalls: unknown[][] = [];
    let eventListener: ((event: any) => void) | undefined;
    let unsubscribed = false;
    const client = {
      subscribe(listener: (event: any) => void) {
        eventListener = listener;
        for (const event of [
          { type: "status", text: "ready" },
          { type: "status" },
          { type: "message_delta", role: "assistant", delta: "owner delta" },
          { type: "message_delta" },
          { type: "message_delta", delta: "default role" },
          { type: "tool", title: "Owner tool", body: "tool body" },
          { type: "tool", toolName: "fallback-tool" },
          { type: "tool" },
          { type: "session_changed", title: "Owner title" },
          { type: "session_changed", sessionId: "owner-session" },
          { type: "session_changed" },
          { type: "payload", payload: { delta: "payload delta" } },
          { type: "payload", payload: { text: "payload text" } },
          { type: "payload", payload: { message: "payload message" } },
          { type: "payload", payload: { owner: true } },
          { type: "other" },
          {},
        ]) {
          listener(event);
        }
        return () => {
          unsubscribed = true;
        };
      },
      submit: async (text: string) => clientCalls.push(["submit", text]),
      abort: async () => clientCalls.push(["abort"]),
      listSessions: async () => [{ id: "owner-session" }],
      resumeSession: async (id: string) => clientCalls.push(["resume", id]),
      listModels: async () => [{ id: "owner/model" }],
      getCommands: async () => [{ name: "/owner" }],
      listBuiltInExtensions: async () => [
        { id: "owner-extension", enabled: true },
      ],
      setBuiltInExtension: async (id: string, enabled: boolean) => {
        clientCalls.push(["extension", id, enabled]);
        return { id, enabled };
      },
      getAutocompleteItems: async (input: string) => [{ value: `${input}ner` }],
      openDialog: async (id: string) => (id ? { id } : undefined),
      respondDialog: async (id: string, payload: unknown) =>
        clientCalls.push(["dialog", id, payload]),
    };

    await desktop.runNativeDesktopGui({
      client,
      env: { RIN_GUI_NATIVE_HOST: `${process.execPath} ${scriptPath}` },
      settingsPath,
    });
    assert.equal(unsubscribed, true);
    assert.equal(typeof eventListener, "function");
    assert.equal(
      clientCalls.some(([name]) => name === "submit"),
      true,
    );
    assert.equal(
      clientCalls.some(([name]) => name === "abort"),
      true,
    );
    assert.equal(
      clientCalls.some(
        ([name, id]) => name === "resume" && id === "owner-session",
      ),
      true,
    );
    assert.equal(
      clientCalls.some(
        ([name, id, enabled]) =>
          name === "extension" && id === "owner-extension" && enabled === true,
      ),
      true,
    );
    assert.equal(
      clientCalls.some(([name]) => name === "dialog"),
      true,
    );

    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    assert.deepEqual(settings, {});
    const captured = await fs.readFile(capturePath, "utf8");
    assert.match(captured, /Connected to local Rin daemon/);
    assert.match(captured, /surface:ready/);
    assert.match(captured, /settings:saved/);
    assert.match(captured, /sessions:list/);
    assert.match(captured, /models:list/);
    assert.match(captured, /commands:list/);
    assert.match(captured, /builtin-extensions:list/);
    assert.match(captured, /autocomplete:list/);
    assert.match(captured, /dialog:open/);
    assert.match(captured, /dialog:respond/);
    assert.match(captured, /rin_native_gui_missing_session/);
    assert.match(captured, /Missing built-in extension id/);
    assert.match(captured, /rin_native_gui_unknown_command:unknown-owner/);
    assert.match(captured, /owner delta/);
    assert.match(captured, /Owner tool\\ntool body/);
    assert.match(captured, /Session: Owner title/);
    assert.match(captured, /Session changed: owner-session/);
    assert.match(captured, /payload message/);
    assert.match(captured, /"owner":true/);

    const preload = desktop.buildElectronDesktopHostPreloadScript();
    assert.match(preload, /contextBridge\.exposeInMainWorld\('rinDesktop'/);
    const assistantMain = desktop.buildElectronDesktopHostMainScript({
      preloadPath: "/tmp/owner preload.cjs",
      title: "Owner Desktop",
    });
    assert.match(assistantMain, /width: 76/);
    assert.match(assistantMain, /alwaysOnTop: true/);
    assert.match(assistantMain, /Owner Desktop/);
    assert.match(assistantMain, /Rin desktop assistant/);
    const chatMain = desktop.buildElectronDesktopHostMainScript({
      preloadPath: "/tmp/chat.cjs",
      surface: "chat",
    });
    assert.match(chatMain, /width: 980/);
    assert.match(chatMain, /alwaysOnTop: false/);
    const installerMain = desktop.buildElectronDesktopHostMainScript({
      preloadPath: "/tmp/installer.cjs",
      surface: "installer",
    });
    assert.match(installerMain, /Rin Installer/);
    assert.match(installerMain, /installer-form/);

    for (const surface of [
      undefined,
      "assistant",
      "chat",
      "installer",
    ] as const) {
      const files = desktop.createElectronDesktopHostFiles({
        title: surface ? `Owner ${surface}` : undefined,
        surface,
      });
      assert.equal(fssync.existsSync(files.preloadPath), true);
      assert.equal(fssync.existsSync(files.mainPath), true);
      assert.match(await fs.readFile(files.preloadPath, "utf8"), /ipcRenderer/);
      await fs.rm(files.dir, { recursive: true, force: true });
    }

    await assert.rejects(
      () =>
        desktop.runElectronDesktopHost({
          electronBinary: process.execPath,
          args: ["--owner-unknown"],
        }),
      /rin_desktop_host_unknown_arg:--owner-unknown/,
    );
    for (const args of [
      [],
      ["--stdio", "--assistant"],
      ["--chat"],
      ["--installer"],
    ]) {
      await desktop.runElectronDesktopHost({
        electronBinary: process.execPath,
        args,
        title: "Owner Electron",
      });
    }
    await assert.rejects(
      () =>
        desktop.runElectronDesktopHost({
          electronBinary: path.join(root, "missing-electron"),
          args: ["--assistant"],
        }),
      /ENOENT/,
    );
  } finally {
    if (oldCapture === undefined) delete process.env.RIN_OWNER_NATIVE_CAPTURE;
    else process.env.RIN_OWNER_NATIVE_CAPTURE = oldCapture;
    await fs.rm(root, { recursive: true, force: true });
  }
});
