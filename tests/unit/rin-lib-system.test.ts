import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const system = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "system.js")).href
);
const common = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "common.js")).href
);

async function withEnv(
  updates: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("rin system normalizes current-user shell launches", () => {
  const currentUser = os.userInfo().username;
  const launch = system.buildUserShell(` ${currentUser} `, ["node", "app.js"], {
    DEMO_FLAG: "1",
  });

  assert.equal(launch.command, "node");
  assert.deepEqual(launch.args, ["app.js"]);
  assert.equal(launch.env.DEMO_FLAG, "1");
  assert.equal(
    system.socketPathForUser(` ${currentUser} `),
    common.defaultDaemonSocketPath(),
  );
});

test("rin system treats current user aliases as the current runtime", () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    "platform",
  );
  const userInfoMock = mock.method(os, "userInfo", () => ({
    username: "THE_cattail",
    uid: -1,
    gid: -1,
    shell: null,
    homedir: "C:\\Users\\THE_cattail",
  }));
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    assert.equal(system.isSameSystemUser("the_cattail", "THE_CATTAIL"), true);
    assert.equal(
      system.socketPathForUser("the_cattail"),
      common.defaultDaemonSocketPath(),
    );
  } finally {
    userInfoMock.mock.restore();
    if (platformDescriptor) {
      Object.defineProperty(process, "platform", platformDescriptor);
    }
  }
});

test("rin system falls back safely for unknown user runtime paths", () => {
  const missingUser = "rin-missing-user-for-test";

  assert.equal(
    system.socketPathForUser(missingUser),
    common.defaultDaemonSocketPath(),
  );
  assert.deepEqual(
    system.targetUserRuntimeEnv(missingUser, { DEMO_FLAG: "1" }),
    {
      DEMO_FLAG: "1",
    },
  );
  assert.throws(
    () => system.buildUserShell(missingUser, ["node", "app.js"]),
    /target_user_not_found:rin-missing-user-for-test/,
  );
});

test("common helpers build stable Windows named pipe paths", () => {
  const first = common.windowsNamedPipePath("daemon", "C:\\Users\\demo");
  const second = common.windowsNamedPipePath("daemon", "C:\\Users\\demo");
  const bridge = common.windowsNamedPipePath("bridge", "C:\\Users\\demo\\.rin");

  assert.equal(first, second);
  assert.match(first, /^\\\\\.\\pipe\\rin-daemon-[a-f0-9]{16}$/);
  assert.match(bridge, /^\\\\\.\\pipe\\rin-bridge-[a-f0-9]{16}$/);
  assert.equal(common.isWindowsNamedPipePath(first), true);
  assert.equal(common.isWindowsNamedPipePath("/run/user/1001/rin.sock"), false);
});

test("defaultDaemonSocketPath keeps runtime dir precedence stable", async () => {
  await withEnv(
    {
      XDG_RUNTIME_DIR: "/tmp/demo-runtime",
    },
    async () => {
      assert.equal(
        common.defaultDaemonSocketPath(),
        path.join("/tmp/demo-runtime", "rin-daemon", "daemon.sock"),
      );
    },
  );
});

test("rin system trims user lookup inputs consistently", () => {
  const currentUser = os.userInfo().username;
  const lookedUp = system.readPasswdUser(` ${currentUser} `);
  const expectedHomeRoot = process.platform === "darwin" ? "/Users" : "/home";

  assert.equal(lookedUp?.name, currentUser);
  assert.equal(
    system.homeForUser(" demo-user "),
    path.join(expectedHomeRoot, "demo-user"),
  );
});

test("shellQuote preserves embedded single quotes for sh -lc", () => {
  const script =
    "const value='node:net'; if (value !== 'node:net') process.exit(41);";
  const command = `${system.shellQuote(process.execPath)} -e ${system.shellQuote(script)}`;
  execFileSync("sh", ["-lc", command], { stdio: "inherit" });
});

test("shellQuote round-trips paths and event names used by daemon probes", () => {
  const script = [
    "const socketPath='/run/user/1001/rin-daemon/daemon.sock';",
    "const eventName='connect';",
    "if (socketPath !== '/run/user/1001/rin-daemon/daemon.sock') process.exit(42);",
    "if (eventName !== 'connect') process.exit(43);",
  ].join("");
  const command = `${system.shellQuote(process.execPath)} -e ${system.shellQuote(script)}`;
  execFileSync("sh", ["-lc", command], { stdio: "inherit" });
  assert.ok(command.includes(`'"'"'connect'"'"'`));
});

test("buildUserShell leaves returned env isolated from later mutations", () => {
  const currentUser = os.userInfo().username;
  const firstLaunch = system.buildUserShell(currentUser, ["node", "app.js"], {
    DEMO_FLAG: "1",
  });
  firstLaunch.env.DEMO_FLAG = "2";

  const secondLaunch = system.buildUserShell(currentUser, ["node", "app.js"], {
    DEMO_FLAG: "1",
  });
  assert.equal(secondLaunch.env.DEMO_FLAG, "1");
});
