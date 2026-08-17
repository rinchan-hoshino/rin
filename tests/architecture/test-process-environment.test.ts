import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  assertTestProcessEnvironment,
  createTestProcessEnvironment,
} from "../../scripts/test/test-process-environment.js";

test("suite process environment cannot reach live Rin or user service state", () => {
  const previousSecret = process.env.RIN_TEST_SECRET;
  const previousBus = process.env.DBUS_SESSION_BUS_ADDRESS;
  const previousInstallInner = process.env.RIN_INSTALL_TUI_CONTAINER_INNER;
  const previousSystemInner = process.env.RIN_SYSTEM_TEST_CONTAINER_INNER;
  const previousCi = process.env.CI;
  process.env.RIN_TEST_SECRET = "must-not-leak";
  process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/live/bus";
  process.env.RIN_INSTALL_TUI_CONTAINER_INNER = "1";
  process.env.RIN_SYSTEM_TEST_CONTAINER_INNER = "1";
  process.env.CI = "1";

  const sandbox = createTestProcessEnvironment("environment-test");
  try {
    assert.equal(sandbox.env.RIN_TEST_SECRET, undefined);
    assert.notEqual(sandbox.env.HOME, process.env.HOME);
    assert.equal(sandbox.env.RIN_DIR, undefined);
    assert.equal(sandbox.env.RIN_AGENT_DIR, undefined);
    assert.equal(
      sandbox.env.RIN_DAEMON_SOCKET_PATH,
      path.join(sandbox.root, "runtime", "rin-daemon", "daemon.sock"),
    );
    assert.equal(sandbox.env.RIN_TEST_SANDBOX_ROOT, sandbox.root);
    assertTestProcessEnvironment(sandbox.env);
    assert.ok(
      String(sandbox.env.DBUS_SESSION_BUS_ADDRESS).includes(sandbox.root),
    );
    assert.equal(sandbox.env.RIN_OFFLINE, undefined);
    assert.equal(sandbox.env.RIN_SKIP_VERSION_CHECK, undefined);
    assert.equal(sandbox.env.RIN_INSTALL_TUI_CONTAINER_INNER, "1");
    assert.equal(sandbox.env.RIN_SYSTEM_TEST_CONTAINER_INNER, "1");
    assert.equal(sandbox.env.CI, undefined);
    assert.equal(sandbox.env.GITHUB_ACTIONS, undefined);
    assert.ok(String(sandbox.env.RIN_TEST_TMPDIR).startsWith(sandbox.root));
    assert.equal(sandbox.env.NO_PROXY, "");
  } finally {
    sandbox.cleanup();
    if (previousSecret == null) delete process.env.RIN_TEST_SECRET;
    else process.env.RIN_TEST_SECRET = previousSecret;
    if (previousBus == null) delete process.env.DBUS_SESSION_BUS_ADDRESS;
    else process.env.DBUS_SESSION_BUS_ADDRESS = previousBus;
    if (previousInstallInner == null) {
      delete process.env.RIN_INSTALL_TUI_CONTAINER_INNER;
    } else {
      process.env.RIN_INSTALL_TUI_CONTAINER_INNER = previousInstallInner;
    }
    if (previousSystemInner == null) {
      delete process.env.RIN_SYSTEM_TEST_CONTAINER_INNER;
    } else {
      process.env.RIN_SYSTEM_TEST_CONTAINER_INNER = previousSystemInner;
    }
    if (previousCi == null) delete process.env.CI;
    else process.env.CI = previousCi;
  }

  assert.equal(fs.existsSync(sandbox.root), false);
});

test("sandbox assertion rejects every live-path escape", () => {
  const sandbox = createTestProcessEnvironment("environment-escape");
  try {
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
      assert.throws(
        () =>
          assertTestProcessEnvironment({
            ...sandbox.env,
            [name]: path.join(path.parse(sandbox.root).root, "live", name),
          }),
        new RegExp(`test_sandbox_path_escape:${name}`),
      );
    }
  } finally {
    sandbox.cleanup();
  }
});

test("every executable test and support entry imports the fail-closed sandbox first", () => {
  const testsRoot = path.resolve("tests");
  const testEntries = fs
    .readdirSync(testsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      fs
        .readdirSync(path.join(testsRoot, entry.name), {
          withFileTypes: true,
        })
        .filter(
          (candidate) =>
            candidate.isFile() &&
            (candidate.name.endsWith(".test.ts") ||
              candidate.name.includes("manual")),
        )
        .map((candidate) => path.join(testsRoot, entry.name, candidate.name)),
    );
  const supportEntries = fs
    .readdirSync(path.join(testsRoot, "support"), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        entry.name !== "require-test-sandbox.ts",
    )
    .map((entry) => path.join(testsRoot, "support", entry.name));
  assert.ok(testEntries.length > 0);
  for (const file of testEntries) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/u);
    const firstCodeLine =
      lines[0] === "#!/usr/bin/env node" ? lines[1] : lines[0];
    assert.equal(
      firstCodeLine,
      'import "../support/require-test-sandbox.ts";',
      `${path.relative(".", file)} can execute before the test sandbox`,
    );
  }
  for (const file of supportEntries) {
    assert.equal(
      fs.readFileSync(file, "utf8").split(/\r?\n/u, 1)[0],
      'import "./require-test-sandbox.ts";',
      `${path.relative(".", file)} can execute before the test sandbox`,
    );
  }
});
