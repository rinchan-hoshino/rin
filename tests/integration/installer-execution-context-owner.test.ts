import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const execution = await importBuiltModule<
  typeof import("../../src/core/rin-install/execution-context.js")
>("dist/core/rin-install/execution-context.js");

test("install execution context resolves target ownership and managed node paths", () => {
  const sameUser = execution.createInstallExecutionContext(
    {
      currentUser: " alice ",
      targetUser: " ",
      installDir: " /srv/rin ",
    },
    {
      platform: "linux",
      targetHomeForUser: (user) => `/home/${user}`,
    },
  );
  assert.deepEqual(sameUser, {
    currentUser: "alice",
    targetUser: "alice",
    targetHome: "/home/alice",
    installDir: "/srv/rin",
    targetNodePath: "/srv/rin/runtime/node/current/bin/node",
    sameUser: true,
  });

  const crossUser = execution.createInstallExecutionContext(
    {
      currentUser: "alice",
      targetUser: " bob ",
      targetHome: " C:/Users/Bob ",
      installDir: " C:/Rin ",
      targetNodePath: " C:/Node/node.exe ",
    },
    {
      platform: "win32",
      targetHomeForUser: () => assert.fail("explicit home was ignored"),
    },
  );
  assert.deepEqual(crossUser, {
    currentUser: "alice",
    targetUser: "bob",
    targetHome: "C:/Users/Bob",
    installDir: "C:/Rin",
    targetNodePath: "C:/Node/node.exe",
    sameUser: false,
  });

  const ambientDefaults = execution.createInstallExecutionContext({
    currentUser: "",
    targetUser: "",
    installDir: "",
  });
  assert.equal(ambientDefaults.currentUser, "");
  assert.equal(ambientDefaults.targetUser, "");
  assert.ok(
    ambientDefaults.targetNodePath.endsWith("runtime/node/current/bin/node"),
  );
});

test("install target commands use the target-user executor only across ownership", () => {
  const calls: any[] = [];
  const deps = {
    runCommandAsUser: (...args: any[]) => calls.push(["run-user", ...args]),
    captureCommandAsUser: (...args: any[]) => {
      calls.push(["capture-user", ...args]);
      return " remote output ";
    },
    execFileSync: (...args: any[]) => {
      calls.push(["exec", ...args]);
      return " local output ";
    },
    env: { BASE: "base" },
  } as any;
  const local = {
    currentUser: "alice",
    targetUser: "alice",
    targetHome: "/home/alice",
    installDir: "/srv/rin",
    targetNodePath: "/srv/rin/node",
    sameUser: true,
  };
  execution.runInstallTargetCommand(
    local,
    "node",
    ["script.js"],
    { EXTRA: "one" },
    deps,
  );
  assert.equal(
    execution.captureInstallTargetCommand(
      local,
      "node",
      ["read.js"],
      { EXTRA: "two" },
      deps,
    ),
    " local output ",
  );
  assert.deepEqual(calls[0], [
    "exec",
    "node",
    ["script.js"],
    { stdio: "inherit", env: { BASE: "base", EXTRA: "one" } },
  ]);
  assert.deepEqual(calls[1], [
    "exec",
    "node",
    ["read.js"],
    { encoding: "utf8", env: { BASE: "base", EXTRA: "two" } },
  ]);

  calls.length = 0;
  const remote = { ...local, targetUser: "bob", sameUser: false };
  execution.runInstallTargetCommand(remote, "node", ["script.js"], {}, deps);
  assert.equal(
    execution.captureInstallTargetCommand(
      remote,
      "node",
      ["read.js"],
      {},
      deps,
    ),
    " remote output ",
  );
  assert.deepEqual(calls, [
    ["run-user", "bob", "node", ["script.js"], {}],
    ["capture-user", "bob", "node", ["read.js"], {}],
  ]);
});

test("install target commands can use the ambient same-user process executor", () => {
  const context = {
    currentUser: "alice",
    targetUser: "alice",
    targetHome: "/home/alice",
    installDir: "/srv/rin",
    targetNodePath: process.execPath,
    sameUser: true,
  };
  const deps = {
    runCommandAsUser: () => assert.fail("wrong executor"),
    captureCommandAsUser: () => assert.fail("wrong executor"),
  };
  execution.runInstallTargetCommand(
    context,
    process.execPath,
    ["-e", ""],
    {},
    deps,
  );
  assert.equal(
    execution.captureInstallTargetCommand(
      context,
      process.execPath,
      ["-e", 'process.stdout.write("native")'],
      {},
      deps,
    ),
    "native",
  );
});

test("install target capture normalizes an empty local command result", () => {
  const context = {
    currentUser: "alice",
    targetUser: "alice",
    targetHome: "/home/alice",
    installDir: "/srv/rin",
    targetNodePath: "/srv/rin/node",
    sameUser: true,
  };
  const result = execution.captureInstallTargetCommand(
    context,
    "node",
    [],
    {},
    {
      runCommandAsUser: () => assert.fail("wrong executor"),
      captureCommandAsUser: () => assert.fail("wrong executor"),
      execFileSync: () => undefined as any,
      env: {},
    },
  );
  assert.equal(result, "");
});
