import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
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

test("sudo target-user shell launches preserve the pi-style parent environment", () => {
  const currentUser = os.userInfo().username;
  const sudoPath = ["/usr/bin/sudo", "/bin/sudo"].find((candidate) =>
    fs.existsSync(candidate),
  );
  const rootUser = system.readPasswdUser("root");

  if (!sudoPath || !rootUser || currentUser === "root") return;

  const launch = system.buildUserShell("root", ["node", "app.js"], {
    RIN_DIR: "/tmp/rin-test",
  });

  assert.equal(launch.command, sudoPath);
  assert.deepEqual(launch.args.slice(0, 4), ["-E", "-u", "root", "env"]);
  assert.equal(launch.env.RIN_DIR, "/tmp/rin-test");
  assert.equal(launch.env.HOME, rootUser.home);
});
