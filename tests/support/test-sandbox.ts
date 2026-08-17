import "./require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

export type TestSandbox = {
  home: string;
  agentDir: string;
  cacheDir: string;
  configDir: string;
  runtimeDir: string;
  env: NodeJS.ProcessEnv;
};

export async function createTestSandbox(
  root: string,
  overrides: NodeJS.ProcessEnv = {},
): Promise<TestSandbox> {
  const home = path.join(root, "home");
  const agentDir = path.join(root, "agent");
  const cacheDir = path.join(root, "cache");
  const configDir = path.join(root, "config");
  const runtimeDir = path.join(root, "runtime");
  const tempDir = path.join(root, "tmp");
  await Promise.all(
    [
      home,
      agentDir,
      cacheDir,
      configDir,
      runtimeDir,
      tempDir,
      path.join(agentDir, "self_improve", "skills"),
      path.join(agentDir, "docs", "rin", "builtin-skills"),
    ].map((directory) => fs.mkdir(directory, { recursive: true })),
  );
  await fs.chmod(runtimeDir, 0o700);

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
    "CI",
    "GITHUB_ACTIONS",
    "NODE_V8_COVERAGE",
    "RIN_INSTALL_TUI_CONTAINER_INNER",
    "RIN_SYSTEM_TEST_CONTAINER_INNER",
    "RIN_TEST_NETWORK_NAMESPACE_INNER",
  ];
  const inherited = Object.fromEntries(
    inheritedNames.flatMap((name) =>
      process.env[name] == null ? [] : [[name, process.env[name]]],
    ),
  );
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    ...overrides,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tempDir,
    TEMP: tempDir,
    TMP: tempDir,
    XDG_CACHE_HOME: cacheDir,
    XDG_CONFIG_HOME: configDir,
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(runtimeDir, "bus")}`,
    RIN_DIR: agentDir,
    RIN_AGENT_DIR: agentDir,
    RIN_DAEMON_SOCKET_PATH: path.join(runtimeDir, "rin-daemon", "daemon.sock"),
    RIN_TEST_SANDBOX_ROOT: root,
    RIN_OFFLINE: "1",
    RIN_SKIP_VERSION_CHECK: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "",
    NO_COLOR: "1",
    NODE_NO_WARNINGS: "1",
  };
  delete env.NODE_OPTIONS;
  assertTestSandbox(env, root);
  return { home, agentDir, cacheDir, configDir, runtimeDir, env };
}

export function assertTestSandbox(env: NodeJS.ProcessEnv, root: string) {
  const sandboxRoot = path.resolve(root);
  for (const name of [
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TEMP",
    "TMP",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_RUNTIME_DIR",
    "RIN_DIR",
    "RIN_AGENT_DIR",
    "RIN_DAEMON_SOCKET_PATH",
  ]) {
    const value = env[name];
    assert.ok(value, `sandbox environment is missing ${name}`);
    const resolved = path.resolve(String(value));
    assert.ok(
      resolved === sandboxRoot ||
        resolved.startsWith(`${sandboxRoot}${path.sep}`),
      `sandbox environment ${name} escapes ${sandboxRoot}: ${resolved}`,
    );
  }
  assert.notEqual(
    path.resolve(String(env.HOME)),
    path.resolve(process.env.HOME || ""),
  );
  assert.equal(path.resolve(String(env.RIN_TEST_SANDBOX_ROOT)), sandboxRoot);
  assert.equal(env.RIN_OFFLINE, "1");
  assert.equal(env.RIN_SKIP_VERSION_CHECK, "1");
  assert.equal(env.NO_PROXY, "");
}
