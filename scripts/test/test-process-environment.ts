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
  const daemonSocketPath = path.join(runtimeDir, "rin-daemon", "daemon.sock");
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
    RIN_DAEMON_SOCKET_PATH: daemonSocketPath,
    RIN_TEST_SANDBOX_ROOT: root,
    RIN_TEST_TMPDIR: tempDir,
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "",
    NO_COLOR: "1",
    NODE_OPTIONS: "--disable-warning=DEP0205",
  };

  assertTestProcessEnvironment(env);
  return {
    env,
    root,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function assertTestProcessEnvironment(env: NodeJS.ProcessEnv): void {
  const rootValue = env.RIN_TEST_SANDBOX_ROOT;
  if (!rootValue) throw new Error("test_sandbox_root_missing");
  const root = path.resolve(rootValue);
  for (const name of [
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TEMP",
    "TMP",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_RUNTIME_DIR",
    "RIN_DAEMON_SOCKET_PATH",
  ]) {
    const value = env[name];
    if (!value) throw new Error(`test_sandbox_path_missing:${name}`);
    const resolved = path.resolve(value);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error(`test_sandbox_path_escape:${name}:${resolved}`);
    }
  }
  for (const name of ["RIN_DIR", "RIN_AGENT_DIR"]) {
    const value = env[name];
    if (!value) continue;
    const resolved = path.resolve(value);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error(`test_sandbox_path_escape:${name}:${resolved}`);
    }
  }
  if (env.NO_PROXY !== "") throw new Error("test_network_bypass_forbidden");
}
