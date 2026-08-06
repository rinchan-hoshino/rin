import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createTestProcessEnvironment(label: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `rin-${label}-`));
  const home = path.join(root, "home");
  const tempDir = path.join(root, "tmp");
  const runtimeDir = path.join(root, "runtime");
  const configDir = path.join(root, "config");
  const cacheDir = path.join(root, "cache");
  for (const directory of [home, tempDir, runtimeDir, configDir, cacheDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.chmodSync(runtimeDir, 0o700);

  const inheritedNames = [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TERM",
    "COLORTERM",
    "DOCKER_HOST",
    "CONTAINER_HOST",
    "RIN_INSTALL_TUI_CONTAINER_INNER",
    "RIN_SYSTEM_TEST_CONTAINER_INNER",
  ];
  const inherited = Object.fromEntries(
    inheritedNames.flatMap((name) =>
      process.env[name] == null ? [] : [[name, process.env[name]]],
    ),
  );
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tempDir,
    TEMP: tempDir,
    TMP: tempDir,
    XDG_CACHE_HOME: cacheDir,
    XDG_CONFIG_HOME: configDir,
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(runtimeDir, "bus")}`,
    RIN_TEST_TMPDIR: tempDir,
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "",
    NO_COLOR: "1",
    NODE_OPTIONS: "--disable-warning=DEP0205",
  };

  return {
    env,
    root,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
