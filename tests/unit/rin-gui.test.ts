import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const gui = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-gui", "web-assets.js"))
    .href
);
const main = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "main.js")).href
);
const nativeDesktop = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-gui", "native-desktop.js"),
  ).href
);

test("GUI args expose no compatibility fallback switches", () => {
  assert.deepEqual(gui.parseRinGuiArgs(["gui"]), {});
  for (const arg of [
    "--native",
    "--web",
    "--host",
    "--port",
    "--open",
    "--no-open",
    "--app",
  ]) {
    assert.throws(
      () => gui.parseRinGuiArgs([arg]),
      new RegExp(`rin_gui_unrecognized_arg:${arg}`),
    );
  }
});

test("native desktop launcher resolves the bundled stdio host directly", () => {
  const launch = nativeDesktop.buildNativeDesktopHostLaunch({});
  assert.equal(launch.command, process.execPath);
  assert.ok(
    launch.args[0].endsWith(
      path.join("dist", "app", "rin-desktop-host", "main.js"),
    ),
  );
  assert.deepEqual(launch.args.slice(1), ["--stdio", "--assistant"]);
  assert.deepEqual(
    nativeDesktop.buildNativeDesktopHostLaunch({
      RIN_GUI_NATIVE_HOST: "custom-host --theme dark",
    }),
    {
      command: "custom-host",
      args: ["--theme", "dark", "--stdio", "--assistant"],
    },
  );
});

test("Electron desktop host is the concrete GUI framework behind the host contract", () => {
  const preload = nativeDesktop.buildElectronDesktopHostPreloadScript();
  const mainScript = nativeDesktop.buildElectronDesktopHostMainScript({
    preloadPath: "/tmp/preload.cjs",
    title: "Rin",
  });
  const installerScript = nativeDesktop.buildElectronDesktopHostMainScript({
    preloadPath: "/tmp/preload.cjs",
    surface: "installer",
  });

  assert.match(mainScript, /BrowserWindow/);
  assert.match(mainScript, /alwaysOnTop: true/);
  assert.match(mainScript, /skipTaskbar: true/);
  assert.match(mainScript, /ipcMain/);
  assert.match(preload, /contextBridge/);
  assert.match(preload, /ipcRenderer/);
  assert.match(preload, /setMode/);
  assert.match(mainScript, /rin-command/);
  assert.match(mainScript, /rin-window-mode/);
  assert.match(mainScript, /setSize\(430, 640\)/);
  assert.match(mainScript, /rin-event/);
  assert.match(mainScript, /Rin desktop assistant/);
  assert.match(mainScript, /settings:get/);
  assert.match(mainScript, /settings:save/);
  assert.match(mainScript, /sessions:list/);
  assert.match(mainScript, /models:list/);
  assert.match(mainScript, /commands:list/);
  assert.match(mainScript, /session:resume/);
  assert.match(installerScript, /Rin Installer/);
  assert.match(installerScript, /installer:apply/);
  assert.doesNotMatch(mainScript, /createServer|WebSocketServer|xdg-open/);
  assert.doesNotMatch(installerScript, /createServer|WebSocketServer|xdg-open/);
  assert.doesNotMatch(preload, /createServer|WebSocketServer|xdg-open/);
});

test("Windows default launch mode is GUI-first while other platforms keep TUI", () => {
  assert.equal(main.defaultLaunchModeForPlatform("win32"), "gui");
  assert.equal(main.defaultLaunchModeForPlatform("linux"), "tui");
  assert.equal(main.defaultLaunchModeForPlatform("darwin"), "tui");
});
