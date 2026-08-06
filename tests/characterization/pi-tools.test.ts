import assert from "node:assert/strict";
import test from "node:test";

import { preparePiManagedToolsForInstall } from "../../src/core/rin-install/pi-tools.js";
import {
  applyRuntimeProfileEnvironment,
  PI_CODING_AGENT_DIR_ENV,
  RIN_DIR_ENV,
} from "../../src/core/rin-lib/profile.js";

test("preparePiManagedToolsForInstall prepares fd and rg in the target Rin agent dir for the current user", async () => {
  const env: NodeJS.ProcessEnv = {};
  const calls: string[] = [];
  const result = await preparePiManagedToolsForInstall(
    {
      currentUser: "rin",
      targetUser: "rin",
      targetHome: "/home/rin",
      installDir: "/home/rin/.rin",
    },
    {
      env,
      ensureTool: async (tool, silent) => {
        calls.push(
          `${tool}:${silent}:${env.HOME}:${env.RIN_DIR}:${env.PI_CODING_AGENT_DIR}`,
        );
        return `/home/rin/.rin/bin/${tool}`;
      },
    },
  );

  assert.deepEqual(result, {
    fd: "/home/rin/.rin/bin/fd",
    rg: "/home/rin/.rin/bin/rg",
    warnings: [],
  });
  assert.deepEqual(calls, [
    "fd:false:/home/rin:/home/rin/.rin:/home/rin/.rin",
    "rg:false:/home/rin:/home/rin/.rin:/home/rin/.rin",
  ]);
  assert.deepEqual(env, {});
});

test("preparePiManagedToolsForInstall runs managed-tool preparation as the target Unix user", async () => {
  const invocations: any[] = [];
  await preparePiManagedToolsForInstall(
    {
      currentUser: "root",
      targetUser: "rin",
      targetHome: "/home/rin",
      installDir: "/home/rin/.rin",
      targetNodePath: "/home/rin/.rin/runtime/node/current/bin/node",
    },
    {
      toolsManagerModuleUrl: "file:///runtime/tools-manager.js",
      runCommandAsUser: (targetUser, command, args, extraEnv) => {
        invocations.push({ targetUser, command, args, extraEnv });
      },
    },
  );

  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].targetUser, "rin");
  assert.equal(
    invocations[0].command,
    "/home/rin/.rin/runtime/node/current/bin/node",
  );
  assert.deepEqual(invocations[0].args.slice(0, 2), [
    "--input-type=module",
    "-e",
  ]);
  assert.match(invocations[0].args[2], /ensureTool\('fd', false\)/);
  assert.match(invocations[0].args[2], /ensureTool\('rg', false\)/);
  assert.match(invocations[0].args[2], /console\.warn/);
  assert.deepEqual(invocations[0].extraEnv, {
    HOME: "/home/rin",
    RIN_DIR: "/home/rin/.rin",
    PI_CODING_AGENT_DIR: "/home/rin/.rin",
  });
});

test("preparePiManagedToolsForInstall refuses ambient process.execPath for cross-user preparation", async () => {
  const invocations: any[] = [];
  const warnings: string[] = [];
  const result = await preparePiManagedToolsForInstall(
    {
      currentUser: "THE_cattail",
      targetUser: "rin",
      targetHome: "/home/rin",
      installDir: "/home/rin/.rin",
    },
    {
      toolsManagerModuleUrl: "file:///runtime/tools-manager.js",
      warn: (message) => warnings.push(message),
      runCommandAsUser: (targetUser, command, args, extraEnv) => {
        invocations.push({ targetUser, command, args, extraEnv });
      },
    },
  );

  assert.equal(invocations.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(warnings, result.warnings);
  assert.match(result.warnings[0], /target Node runtime is unavailable/);
});

test("preparePiManagedToolsForInstall does not fail install when managed tools cannot be prepared", async () => {
  const warnings: string[] = [];
  const result = await preparePiManagedToolsForInstall(
    {
      currentUser: "rin",
      targetUser: "rin",
      targetHome: "/home/rin",
      installDir: "/home/rin/.rin",
    },
    {
      env: {},
      warn: (message) => warnings.push(message),
      ensureTool: async (tool) => {
        if (tool === "fd") return undefined;
        throw new Error("GitHub API error: 403");
      },
    },
  );

  assert.equal(result.fd, undefined);
  assert.equal(result.rg, undefined);
  assert.ok(result.warnings.length >= 2);
  assert.deepEqual(warnings, result.warnings);
});

test("applyRuntimeProfileEnvironment pins Pi managed binaries to the Rin agent dir", () => {
  const previousRinDir = process.env[RIN_DIR_ENV];
  const previousPiDir = process.env[PI_CODING_AGENT_DIR_ENV];
  try {
    applyRuntimeProfileEnvironment({ agentDir: "/tmp/rin-agent" });
    assert.equal(process.env[RIN_DIR_ENV], "/tmp/rin-agent");
    assert.equal(process.env[PI_CODING_AGENT_DIR_ENV], "/tmp/rin-agent");
  } finally {
    if (previousRinDir === undefined) delete process.env[RIN_DIR_ENV];
    else process.env[RIN_DIR_ENV] = previousRinDir;
    if (previousPiDir === undefined)
      delete process.env[PI_CODING_AGENT_DIR_ENV];
    else process.env[PI_CODING_AGENT_DIR_ENV] = previousPiDir;
  }
});
