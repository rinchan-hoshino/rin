import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const users = await importBuiltModule<
  typeof import("../../src/core/rin-install/users.js")
>("dist/core/rin-install/users.js");

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-users-owner-"));
  try {
    await run(dir);
  } finally {
    await fs.chmod(dir, 0o700).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("installer user identities normalize Unix and Windows accounts", () => {
  assert.equal(users.normalizeUserName(null), "");
  assert.equal(users.normalizeUserName(0), "");
  assert.equal(users.normalizeUserName("  owner  "), "owner");

  assert.equal(users.isSameSystemUser("", "owner", "linux"), false);
  assert.equal(users.isSameSystemUser("owner", "owner", "linux"), true);
  assert.equal(users.isSameSystemUser("Owner", "owner", "linux"), false);
  assert.equal(users.isSameSystemUser("DESKTOP/Owner", "owner", "win32"), true);
  assert.equal(
    users.isSameSystemUser("domain\\owner", "other\\owner", "win32"),
    false,
  );
  assert.equal(
    users.isSameSystemUser("domain\\owner", "domain\\other", "win32"),
    false,
  );
  assert.equal(users.isSameSystemUser("\\", "other", "win32"), false);
});

test("installer user discovery normalizes incomplete and unavailable current profiles", () => {
  const incomplete = mock.method(
    os,
    "userInfo",
    () =>
      ({
        username: "profile-owner",
        uid: undefined,
        gid: undefined,
        homedir: "",
        shell: "",
      }) as never,
  );
  try {
    assert.deepEqual(users.findSystemUser("profile-owner"), {
      name: "profile-owner",
      uid: -1,
      gid: -1,
      home: "/home/profile-owner",
      shell: "",
    });
  } finally {
    incomplete.mock.restore();
  }

  const unavailable = mock.method(os, "userInfo", () => {
    throw new Error("profile unavailable");
  });
  try {
    assert.equal(users.findSystemUser("rin-owner-missing-account"), undefined);
  } finally {
    unavailable.mock.restore();
  }
});

test("installer user discovery reads and sorts the active OS account source", async () => {
  const current = os.userInfo();
  const listed = users.listSystemUsers();
  assert.ok(Array.isArray(listed));
  for (let index = 1; index < listed.length; index += 1) {
    const previous = listed[index - 1];
    const next = listed[index];
    assert.ok(
      previous.uid < next.uid ||
        (previous.uid === next.uid &&
          previous.name.localeCompare(next.name) <= 0),
    );
  }

  assert.deepEqual(users.findSystemUser(` ${current.username} `), {
    name: current.username,
    uid: current.uid,
    gid: current.gid,
    home: current.homedir,
    shell: current.shell,
  });
  assert.equal(users.findSystemUser("  "), undefined);
  assert.equal(users.findSystemUser("rin-owner-missing-account"), undefined);
  assert.equal(
    users.homeForUser("rin-owner-missing-account"),
    "/home/rin-owner-missing-account",
  );
  assert.equal(
    users.targetHomeForUser("rin-owner-missing-account"),
    users.homeForUser("rin-owner-missing-account"),
  );
});

test("installer user discovery filters Darwin account records", async () => {
  await withTempDir(async (dir) => {
    const binDir = path.join(dir, "bin");
    const dsclPath = path.join(binDir, "dscl");
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(
      dsclPath,
      `#!/bin/sh
if [ "$2" = "-list" ]; then
  printf 'broken line\\nnobody 499\\nservice 500\\nzeta 502\\nalpha 502\\nmissing 503\\n'
  exit 0
fi
name=$(printf '%s' "$3" | awk -F/ '{print $3}')
case "$4:$name" in
  UserShell:service) printf 'UserShell: /usr/bin/false\\n' ;;
  UserShell:zeta) printf 'UserShell: /bin/zsh\\n' ;;
  UserShell:alpha) printf 'UserShell: /bin/bash\\n' ;;
  UserShell:missing) printf 'unrelated: value\\n' ;;
  NFSHomeDirectory:zeta) printf 'NFSHomeDirectory: /Users/zeta\\n' ;;
  NFSHomeDirectory:alpha) printf 'NFSHomeDirectory:   \\n' ;;
  NFSHomeDirectory:missing) exit 1 ;;
  PrimaryGroupID:zeta) printf 'PrimaryGroupID: 42\\n' ;;
  PrimaryGroupID:alpha) printf 'PrimaryGroupID:   \\n' ;;
  PrimaryGroupID:missing) printf 'PrimaryGroupID: 55\\n' ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    );

    const previousPath = process.env.PATH;
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    );
    process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      assert.deepEqual(users.listSystemUsers(), [
        {
          name: "alpha",
          uid: 502,
          gid: 20,
          home: "/Users/alpha",
          shell: "/bin/bash",
        },
        {
          name: "zeta",
          uid: 502,
          gid: 42,
          home: "/Users/zeta",
          shell: "/bin/zsh",
        },
        {
          name: "missing",
          uid: 503,
          gid: 55,
          home: "/Users/missing",
          shell: "",
        },
      ]);
      await fs.rm(dsclPath);
      assert.deepEqual(users.listSystemUsers(), []);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (platformDescriptor)
        Object.defineProperty(process, "platform", platformDescriptor);
    }
  });
});

test("installer ownership decisions reflect target identity and access", async () => {
  await withTempDir(async (dir) => {
    const currentUser = os.userInfo().username;
    const ownership = users.describeOwnership(currentUser, dir);
    assert.equal(ownership.ownerMatches, true);
    assert.equal(ownership.writable, true);
    assert.equal(users.shouldUseElevatedWrite(currentUser, ownership), false);
    assert.equal(
      users.shouldUseElevatedWrite("other-user", ownership, currentUser),
      true,
    );
    assert.equal(
      users.shouldUseElevatedWrite(
        currentUser,
        { ...ownership, ownerMatches: false },
        currentUser,
      ),
      true,
    );
    assert.equal(
      users.shouldUseElevatedWrite(
        currentUser,
        { ...ownership, writable: false },
        currentUser,
      ),
      true,
    );

    assert.deepEqual(
      users.describeOwnership("missing-user", path.join(dir, "missing")),
      {
        ownerMatches: true,
        writable: true,
        statUid: -1,
        statGid: -1,
        targetUid: -1,
        targetGid: -1,
      },
    );
  });
});
