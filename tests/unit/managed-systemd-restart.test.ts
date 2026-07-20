import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  runManagedSystemdServiceAction,
  setManagedServiceStartHold,
  setSystemdUnitFileHold,
  setWindowsStartupEntryHold,
} from "../../dist/core/rin/managed-runtime-service.js";

test("Windows startup hold atomically removes and restores the startup entry", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rin-startup-hold-"));
  try {
    const startupPath = path.join(root, "rin-daemon.cmd");
    fs.writeFileSync(startupPath, "daemon");
    const heldPath = setWindowsStartupEntryHold(startupPath, true);
    assert.equal(fs.existsSync(startupPath), false);
    assert.equal(fs.readFileSync(heldPath, "utf8"), "daemon");
    assert.equal(setWindowsStartupEntryHold(startupPath, true), heldPath);
    assert.equal(setWindowsStartupEntryHold(startupPath, false), startupPath);
    assert.equal(fs.readFileSync(startupPath, "utf8"), "daemon");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("systemd update hold persistently masks the unit file until release", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rin-systemd-hold-"));
  try {
    const unitPath = path.join(root, "rin-daemon-rin.service");
    fs.writeFileSync(unitPath, "service");
    const executed = [];
    const captured = [];
    const events = [];
    const context = {
      currentUser: "rin",
      targetUser: "rin",
      isTargetUser: true,
      elevated: false,
      systemctl: "/usr/bin/systemctl",
      capture(command) {
        captured.push(command);
        events.push(`capture:${command[2]}`);
        return "";
      },
      exec(command) {
        executed.push(command);
        events.push(`exec:${command[2]}`);
        return "";
      },
    };
    const service = {
      kind: "systemd",
      label: "rin-daemon-rin.service",
      path: unitPath,
    };

    await setManagedServiceStartHold(context, true, service);
    assert.equal(fs.readlinkSync(unitPath), "/dev/null");
    assert.equal(
      fs.readFileSync(`${unitPath}.rin-update-hold`, "utf8"),
      "service",
    );
    await setManagedServiceStartHold(context, false, service);
    assert.equal(fs.readFileSync(unitPath, "utf8"), "service");

    assert.deepEqual(executed, [
      [
        "/usr/bin/systemctl",
        "--user",
        "mask",
        "--runtime",
        "rin-daemon-rin.service",
      ],
      [
        "/usr/bin/systemctl",
        "--user",
        "unmask",
        "--runtime",
        "rin-daemon-rin.service",
      ],
    ]);
    assert.deepEqual(captured, [
      ["/usr/bin/systemctl", "--user", "daemon-reload"],
      ["/usr/bin/systemctl", "--user", "daemon-reload"],
    ]);
    assert.deepEqual(events, [
      "exec:mask",
      "capture:daemon-reload",
      "capture:daemon-reload",
      "exec:unmask",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cross-user systemd hold delegates unit-file mutation to target executor", async () => {
  const delegated = [];
  const executed = [];
  const captured = [];
  const context = {
    currentUser: "owner",
    targetUser: "rin",
    isTargetUser: false,
    elevated: false,
    systemctl: "/usr/bin/systemctl",
    holdServiceFile(kind, filePath, hold) {
      delegated.push({ kind, filePath, hold });
    },
    capture(command) {
      captured.push(command);
      return "";
    },
    exec(command) {
      executed.push(command);
      return "";
    },
  };
  const service = {
    kind: "systemd",
    label: "rin-daemon-rin.service",
    path: "/home/rin/.config/systemd/user/rin-daemon-rin.service",
  };

  await setManagedServiceStartHold(context, true, service);
  await setManagedServiceStartHold(context, false, service);

  assert.deepEqual(delegated, [
    { kind: "systemd", filePath: service.path, hold: true },
    { kind: "systemd", filePath: service.path, hold: false },
  ]);
  assert.deepEqual(
    executed.map((item) => item[2]),
    ["mask", "unmask"],
  );
  assert.deepEqual(
    captured.map((item) => item[2]),
    ["daemon-reload", "daemon-reload"],
  );
});

test("systemd unit-file hold recovers a rename interrupted before masking", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rin-systemd-hold-"));
  try {
    const unitPath = path.join(root, "rin-daemon.service");
    const heldPath = `${unitPath}.rin-update-hold`;
    fs.writeFileSync(heldPath, "service");
    assert.equal(setSystemdUnitFileHold(unitPath, true), heldPath);
    assert.equal(fs.readlinkSync(unitPath), "/dev/null");
    assert.equal(setSystemdUnitFileHold(unitPath, false), unitPath);
    assert.equal(fs.readFileSync(unitPath, "utf8"), "service");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("systemd restart does not use active-only status as a unit existence probe", () => {
  const captured = [];
  const executed = [];
  const context = {
    currentUser: "rin",
    targetUser: "rin",
    elevated: false,
    systemctl: "/usr/bin/systemctl",
    capture(command) {
      captured.push(command);
      return "";
    },
    exec(command) {
      executed.push(command);
      return "";
    },
  };
  const service = {
    kind: "systemd",
    label: "rin-daemon-rin.service",
    servicePath: "/home/rin/.config/systemd/user/rin-daemon-rin.service",
  };

  const result = runManagedSystemdServiceAction(context, service, "restart");

  assert.equal(result, service.label);
  assert.deepEqual(captured, [
    ["/usr/bin/systemctl", "--user", "daemon-reload"],
  ]);
  assert.deepEqual(executed, [
    ["/usr/bin/systemctl", "--user", "restart", "rin-daemon-rin.service"],
  ]);
});
