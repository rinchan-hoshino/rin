import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const users = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "users.js"))
    .href
);

async function withTempDir(fn) {
  await fs.mkdir("/home/rin/tmp", { recursive: true });
  const dir = await fs.mkdtemp(
    path.join("/home/rin/tmp", "rin-installer-users-"),
  );
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("installer users keep system user lists deterministically sorted", () => {
  const listed = users.listSystemUsers();
  for (let index = 1; index < listed.length; index += 1) {
    const previous = listed[index - 1];
    const current = listed[index];
    assert.ok(
      previous.uid < current.uid ||
        (previous.uid === current.uid &&
          previous.name.localeCompare(current.name) <= 0),
    );
  }
});

test("installer users normalize lookup and home fallback behavior", () => {
  assert.equal(users.findSystemUser("   "), undefined);
  assert.equal(users.homeForUser(" demo-user "), "/home/demo-user");
  assert.equal(users.targetHomeForUser(" demo-user "), "/home/demo-user");
  assert.equal(
    users.targetHomeForUser(" demo-user "),
    users.homeForUser(" demo-user "),
  );
});

test("installer users keep macOS dscl users when home key is missing", async () => {
  await withTempDir(async (dir) => {
    const binDir = path.join(dir, "bin");
    await fs.mkdir(binDir, { recursive: true });
    const dsclPath = path.join(binDir, "dscl");
    await fs.writeFile(
      dsclPath,
      `#!/bin/sh
if [ "$1" = "." ] && [ "$2" = "-list" ]; then
  printf 'mobile 501\\n'
  exit 0
fi
if [ "$1" = "." ] && [ "$2" = "-read" ]; then
  case "$4" in
    NFSHomeDirectory)
      echo 'No such key: NFSHomeDirectory' >&2
      exit 1
      ;;
    UserShell)
      printf 'UserShell: /bin/zsh\\n'
      exit 0
      ;;
    PrimaryGroupID)
      printf 'PrimaryGroupID: 20\\n'
      exit 0
      ;;
  esac
fi
exit 1
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
          name: "mobile",
          uid: 501,
          gid: 20,
          home: "/Users/mobile",
          shell: "/bin/zsh",
        },
      ]);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (platformDescriptor)
        Object.defineProperty(process, "platform", platformDescriptor);
    }
  });
});

test("installer users compare Windows account aliases case-insensitively", () => {
  assert.equal(users.isSameSystemUser("DESKTOP\\Demo", "demo", "win32"), true);
  assert.equal(users.isSameSystemUser("desktop/demo", "DEMO", "win32"), true);
  assert.equal(
    users.isSameSystemUser("desktop\\demo", "other\\demo", "win32"),
    false,
  );
  assert.equal(users.isSameSystemUser("alice", "Alice", "linux"), false);
});

test("installer users prefer the current system profile home", () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    "platform",
  );
  const userInfoMock = mock.method(os, "userInfo", () => ({
    username: "the_cattail",
    uid: -1,
    gid: -1,
    shell: "",
    homedir: "C:\\Users\\THE_cattail",
  }));
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    assert.deepEqual(users.findSystemUser("CATTAIL-PC\\THE_CATTAIL"), {
      name: "the_cattail",
      uid: -1,
      gid: -1,
      home: "C:\\Users\\THE_cattail",
      shell: "",
    });
    assert.equal(users.homeForUser("the_cattail"), "C:\\Users\\THE_cattail");
    assert.equal(
      users.targetHomeForUser("CATTAIL-PC\\the_cattail"),
      "C:\\Users\\THE_cattail",
    );
  } finally {
    userInfoMock.mock.restore();
    if (platformDescriptor) {
      Object.defineProperty(process, "platform", platformDescriptor);
    }
  }
});

test("installer users avoid elevated writes for Windows current-user aliases", () => {
  const ownership = {
    ownerMatches: true,
    writable: true,
    statUid: -1,
    statGid: -1,
    targetUid: -1,
    targetGid: -1,
  };
  assert.equal(
    users.shouldUseElevatedWrite("DESKTOP\\Demo", ownership, "demo", "win32"),
    false,
  );
  assert.equal(
    users.shouldUseElevatedWrite("DESKTOP\\Other", ownership, "demo", "win32"),
    true,
  );
});

test("installer users describe ownership and elevated write decisions consistently", async () => {
  await withTempDir(async (dir) => {
    const currentUser = os.userInfo().username;
    const ownership = users.describeOwnership(` ${currentUser} `, dir);

    assert.equal(ownership.writable, true);
    assert.equal(Number.isInteger(ownership.statUid), true);
    assert.equal(Number.isInteger(ownership.statGid), true);
    assert.equal(
      users.shouldUseElevatedWrite(` ${currentUser} `, ownership),
      false,
    );
    assert.equal(users.shouldUseElevatedWrite("other-user", ownership), true);

    const missing = users.describeOwnership(
      "missing-user",
      path.join(dir, "missing"),
    );
    assert.deepEqual(missing, {
      ownerMatches: true,
      writable: true,
      statUid: -1,
      statGid: -1,
      targetUid: -1,
      targetGid: -1,
    });
  });
});
