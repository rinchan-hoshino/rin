import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import test, { mock } from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const system = await importBuiltModule<
  typeof import("../../src/core/rin-lib/system.js")
>("dist/core/rin-lib/system.js");

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return run();
  } finally {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
  }
}

test("system user comparison normalizes Unix and Windows identities", () => {
  assert.equal(system.isSameSystemUser("", "owner", "linux"), false);
  assert.equal(system.isSameSystemUser("owner", "owner", "linux"), true);
  assert.equal(system.isSameSystemUser("Owner", "owner", "linux"), false);
  assert.equal(
    system.isSameSystemUser("DOMAIN/Owner", "domain\\owner", "win32"),
    true,
  );
  assert.equal(system.isSameSystemUser("Owner", "OTHER\\owner", "win32"), true);
  assert.equal(
    system.isSameSystemUser("ONE\\owner", "TWO\\owner", "win32"),
    false,
  );
  assert.equal(system.shellQuote("a'b"), `'a'"'"'b'`);
});

test("system user lookup resolves Unix records and fallbacks", () => {
  const current = os.userInfo().username;
  assert.equal(system.readPasswdUser(""), null);
  assert.equal(system.readPasswdUser("definitely-missing-owner-user"), null);
  assert.equal(system.readPasswdUser(current)?.name, current);
  assert.ok(system.homeForUser(current));
  assert.equal(
    system.homeForUser("definitely-missing-owner-user"),
    "/home/definitely-missing-owner-user",
  );
  assert.ok(system.pickPrivilegeCommand());
});

test("system user lookup parses and rejects macOS directory records", () => {
  const exec = mock.method(
    childProcess,
    "execFileSync",
    () => "NFSHomeDirectory: /Users/owner\nUserShell: /bin/zsh\n",
  );
  syncBuiltinESMExports();
  try {
    const found = withPlatform("darwin", () => system.readPasswdUser("owner"));
    assert.deepEqual(found, {
      name: "owner",
      home: "/Users/owner",
      shell: "/bin/zsh",
    });
    exec.mock.mockImplementation(() => {
      throw new Error("missing");
    });
    assert.equal(
      withPlatform("darwin", () => system.readPasswdUser("missing")),
      null,
    );
  } finally {
    exec.mock.restore();
    syncBuiltinESMExports();
  }
});

test("system socket paths follow current, Windows, macOS, and Unix targets", () => {
  const current = os.userInfo().username;
  assert.match(system.socketPathForUser(current), /daemon/);
  assert.match(
    withPlatform("win32", () => system.socketPathForUser("other-user")),
    /^\\\\\.\\pipe\\rin-/,
  );
  assert.equal(
    withPlatform("darwin", () => system.socketPathForUser("other-user")),
    "/Users/other-user/Library/Caches/rin-daemon/daemon.sock",
  );
  assert.match(
    system.socketPathForUser("nobody"),
    /\/run\/user\/\d+\/rin-daemon\/daemon\.sock/,
  );
  assert.match(
    system.socketPathForUser("definitely-missing-owner-user"),
    /rin-daemon/,
  );
});

test("target runtime environment adds only existing user runtime paths", () => {
  const exists = mock.method(fs, "existsSync", (filePath: fs.PathLike) =>
    String(filePath).endsWith("/bus"),
  );
  try {
    const rootEnv = system.targetUserRuntimeEnv("root", { OWNER_TEST: "1" });
    assert.equal(rootEnv.OWNER_TEST, "1");
    assert.equal(rootEnv.XDG_RUNTIME_DIR, undefined);
    assert.equal(rootEnv.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/0/bus");
  } finally {
    exists.mock.restore();
  }
  const missing = system.targetUserRuntimeEnv("definitely-missing-owner-user");
  assert.equal(missing.XDG_RUNTIME_DIR, undefined);
  assert.equal(missing.DBUS_SESSION_BUS_ADDRESS, undefined);
});

test("user shell construction handles direct and privileged launch shapes", () => {
  const current = os.userInfo().username;
  const direct = system.buildUserShell(current, ["node", "script.js"], {
    OWNER_TEST: "yes",
  });
  assert.equal(direct.command, "node");
  assert.deepEqual(direct.args, ["script.js"]);
  assert.equal(direct.env.OWNER_TEST, "yes");

  const exists = mock.method(fs, "existsSync", (filePath: fs.PathLike) =>
    String(filePath).endsWith("/pkexec"),
  );
  try {
    const privileged = system.buildUserShell("nobody", ["printf", "a'b"], {
      OWNER_TEST: "value with spaces",
    });
    assert.match(privileged.command, /pkexec$/);
    assert.deepEqual(privileged.args.slice(0, 2), ["sh", "-lc"]);
    assert.match(privileged.args[2], /OWNER_TEST='value with spaces'/);
    assert.match(privileged.args[2], /'a'"'"'b'/);
    assert.equal(privileged.env.HOME, system.homeForUser("nobody"));
  } finally {
    exists.mock.restore();
  }

  assert.throws(
    () => system.buildUserShell("definitely-missing-owner-user", ["true"]),
    /target_user_not_found/,
  );
});
