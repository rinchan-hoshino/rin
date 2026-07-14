import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createTestProcessEnvironment } from "../../scripts/test/test-process-environment.js";

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
    assert.ok(
      path
        .join(String(sandbox.env.HOME), ".rin")
        .startsWith(`${sandbox.root}${path.sep}`),
    );
    assert.ok(
      String(sandbox.env.DBUS_SESSION_BUS_ADDRESS).includes(sandbox.root),
    );
    assert.equal(sandbox.env.RIN_OFFLINE, undefined);
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
