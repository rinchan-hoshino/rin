import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { runManagedSystemdServiceAction } from "../../dist/core/rin/managed-runtime-service.js";
import { recoverOwnedLegacySystemdUnitHold } from "../../dist/core/rin-install/legacy-service-hold.js";
import { recoverOwnedLegacySystemdServiceHold } from "../../dist/core/rin-install/service.js";

test("installer restores only a complete Rin-owned legacy systemd hold", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rin-systemd-hold-"));
  try {
    const targetUser = os.userInfo().username;
    const unitPath = path.join(
      root,
      ".config",
      "systemd",
      "user",
      `rin-daemon-${targetUser}.service`,
    );
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(`${unitPath}.rin-update-hold`, "service");
    fs.symlinkSync("/dev/null", unitPath);
    const systemdCalls = [];

    assert.equal(
      recoverOwnedLegacySystemdServiceHold(
        targetUser,
        path.join(root, ".rin"),
        false,
        {
          findSystemUser: () => ({
            uid: process.getuid?.(),
            gid: process.getgid?.(),
            homeDir: root,
          }),
          targetHomeForUser: () => root,
          runSystemdCommand(_user, _context, args) {
            systemdCalls.push(args);
          },
        },
      ),
      true,
    );
    assert.equal(fs.readFileSync(unitPath, "utf8"), "service");
    assert.equal(fs.existsSync(`${unitPath}.rin-update-hold`), false);
    assert.deepEqual(systemdCalls, [["daemon-reload"]]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy recovery removes only the paired runtime mask entry", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-systemd-runtime-mask-"),
  );
  try {
    const unitPath = path.join(root, "rin-daemon.service");
    const runtimeMaskPath = path.join(root, "runtime", "rin-daemon.service");
    fs.mkdirSync(path.dirname(runtimeMaskPath), { recursive: true });
    fs.writeFileSync(`${unitPath}.rin-update-hold`, "service");
    fs.symlinkSync("/dev/null", unitPath);
    fs.symlinkSync("/dev/null", runtimeMaskPath);

    assert.equal(
      recoverOwnedLegacySystemdUnitHold(unitPath, { runtimeMaskPath }),
      true,
    );
    assert.equal(fs.readFileSync(unitPath, "utf8"), "service");
    assert.equal(fs.existsSync(`${unitPath}.rin-update-hold`), false);
    assert.equal(fs.existsSync(runtimeMaskPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy recovery restores a concurrent administrator unit without replacement", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rin-systemd-unit-race-"));
  const unitPath = path.join(root, "rin-daemon.service");
  const heldPath = `${unitPath}.rin-update-hold`;
  fs.writeFileSync(heldPath, "legacy-service");
  fs.symlinkSync("/dev/null", unitPath);

  const originalRenameSync = fs.renameSync;
  let raced = false;
  try {
    (fs as any).renameSync = (
      source: fs.PathLike,
      destination: fs.PathLike,
    ) => {
      if (!raced && String(source) === unitPath) {
        raced = true;
        fs.unlinkSync(unitPath);
        fs.writeFileSync(unitPath, "administrator-service");
      }
      return originalRenameSync(source, destination);
    };
    assert.throws(
      () => recoverOwnedLegacySystemdUnitHold(unitPath),
      /rin_systemd_legacy_hold_ambiguous/,
    );
  } finally {
    (fs as any).renameSync = originalRenameSync;
  }

  assert.equal(raced, true);
  assert.equal(fs.readFileSync(unitPath, "utf8"), "administrator-service");
  assert.equal(fs.readFileSync(heldPath, "utf8"), "legacy-service");
  fs.rmSync(root, { recursive: true, force: true });
});

test("legacy recovery restores a concurrent administrator runtime entry", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-systemd-runtime-race-"),
  );
  const unitPath = path.join(root, "rin-daemon.service");
  const heldPath = `${unitPath}.rin-update-hold`;
  const runtimeMaskPath = path.join(root, "runtime", "rin-daemon.service");
  fs.mkdirSync(path.dirname(runtimeMaskPath), { recursive: true });
  fs.writeFileSync(heldPath, "legacy-service");
  fs.symlinkSync("/dev/null", unitPath);
  fs.symlinkSync("/dev/null", runtimeMaskPath);

  const originalRenameSync = fs.renameSync;
  let raced = false;
  try {
    (fs as any).renameSync = (
      source: fs.PathLike,
      destination: fs.PathLike,
    ) => {
      if (!raced && String(source) === runtimeMaskPath) {
        raced = true;
        fs.unlinkSync(runtimeMaskPath);
        fs.writeFileSync(runtimeMaskPath, "administrator-runtime-entry");
      }
      return originalRenameSync(source, destination);
    };
    assert.throws(
      () => recoverOwnedLegacySystemdUnitHold(unitPath, { runtimeMaskPath }),
      /rin_systemd_legacy_hold_ambiguous/,
    );
  } finally {
    (fs as any).renameSync = originalRenameSync;
  }

  assert.equal(raced, true);
  assert.equal(fs.readlinkSync(unitPath), "/dev/null");
  assert.equal(fs.readFileSync(heldPath, "utf8"), "legacy-service");
  assert.equal(
    fs.readFileSync(runtimeMaskPath, "utf8"),
    "administrator-runtime-entry",
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("installer preserves an administrator-masked systemd unit", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-systemd-admin-mask-"),
  );
  try {
    const targetUser = os.userInfo().username;
    const unitPath = path.join(
      root,
      ".config",
      "systemd",
      "user",
      `rin-daemon-${targetUser}.service`,
    );
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.symlinkSync("/dev/null", unitPath);
    const systemdCalls = [];

    assert.equal(
      recoverOwnedLegacySystemdServiceHold(
        targetUser,
        path.join(root, ".rin"),
        false,
        {
          findSystemUser: () => ({
            uid: process.getuid?.(),
            gid: process.getgid?.(),
            homeDir: root,
          }),
          targetHomeForUser: () => root,
          runSystemdCommand(_user, _context, args) {
            systemdCalls.push(args);
          },
        },
      ),
      false,
    );
    assert.deepEqual(systemdCalls, []);
    assert.equal(fs.readlinkSync(unitPath), "/dev/null");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("installer rejects a held payload when the unit mask is missing", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-systemd-missing-mask-"),
  );
  try {
    const targetUser = os.userInfo().username;
    const unitPath = path.join(
      root,
      ".config",
      "systemd",
      "user",
      `rin-daemon-${targetUser}.service`,
    );
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(`${unitPath}.rin-update-hold`, "unpaired");

    assert.throws(
      () =>
        recoverOwnedLegacySystemdServiceHold(
          targetUser,
          path.join(root, ".rin"),
          false,
          {
            findSystemUser: () => ({
              uid: process.getuid?.(),
              gid: process.getgid?.(),
              homeDir: root,
            }),
            targetHomeForUser: () => root,
            runSystemdCommand() {
              assert.fail("an incomplete hold must not be unmasked");
            },
          },
        ),
      /rin_systemd_legacy_hold_ambiguous/,
    );
    assert.equal(
      fs.readFileSync(`${unitPath}.rin-update-hold`, "utf8"),
      "unpaired",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("elevated legacy recovery leaves an unowned mask untouched", () => {
  const systemdCalls = [];
  const recovered = recoverOwnedLegacySystemdServiceHold(
    "target-user",
    "/private/.rin",
    true,
    {
      findSystemUser: () => ({ uid: 1234, gid: 1234, homeDir: "/private" }),
      targetHomeForUser: () => "/private",
      captureTargetCommand() {
        return "none\n";
      },
      runSystemdCommand(_user, _context, args) {
        systemdCalls.push(args);
      },
    },
  );
  assert.equal(recovered, false);
  assert.deepEqual(systemdCalls, []);
});

test("elevated legacy recovery rejects a symlinked held payload", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-systemd-held-symlink-"),
  );
  try {
    const targetUser = os.userInfo().username;
    const unitPath = path.join(
      root,
      ".config",
      "systemd",
      "user",
      `rin-daemon-${targetUser}.service`,
    );
    const payloadPath = path.join(root, "payload.service");
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(payloadPath, "administrator-owned");
    fs.symlinkSync(payloadPath, `${unitPath}.rin-update-hold`);
    fs.symlinkSync("/dev/null", unitPath);

    assert.throws(
      () =>
        recoverOwnedLegacySystemdServiceHold(
          targetUser,
          path.join(root, ".rin"),
          true,
          {
            findSystemUser: () => ({
              uid: process.getuid?.(),
              gid: process.getgid?.(),
              homeDir: root,
            }),
            targetHomeForUser: () => root,
            targetNodePath: process.execPath,
            captureTargetCommand(_user, command, args) {
              return execFileSync(command, args, { encoding: "utf8" });
            },
            runSystemdCommand() {
              assert.fail("an unowned hold must not be unmasked");
            },
          },
        ),
      /rin_systemd_legacy_hold_ambiguous/,
    );
    assert.equal(fs.readlinkSync(unitPath), "/dev/null");
    assert.equal(fs.readlinkSync(`${unitPath}.rin-update-hold`), payloadPath);
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
