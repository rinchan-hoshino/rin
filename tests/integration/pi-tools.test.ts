import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

await import("../support/register-pi-tools-owner-fixture.js");

const piTools = await importBuiltModule<
  typeof import("../../src/core/rin-install/pi-tools.js")
>("dist/core/rin-install/pi-tools.js");

const localOptions = {
  currentUser: "rin",
  targetUser: "rin",
  targetHome: "/home/rin",
  installDir: "/home/rin/.rin",
};

test("managed Pi tools require an explicit installation directory", async () => {
  await assert.rejects(
    () =>
      piTools.preparePiManagedToolsForInstall({
        ...localOptions,
        installDir: "   ",
      }),
    /rin_installer_fd_install_dir_missing/,
  );
});

test("managed Pi tools load the default manager and contain unavailable-manager failures", async () => {
  const ownerGlobal = globalThis as any;
  ownerGlobal.__rinPiToolsOwnerModule = {
    ensureTool: async (tool: string) => `/owner/bin/${tool}`,
  };
  assert.deepEqual(
    await piTools.preparePiManagedToolsForInstall(localOptions, { env: {} }),
    {
      fd: "/owner/bin/fd",
      rg: "/owner/bin/rg",
      warnings: [],
    },
  );

  ownerGlobal.__rinPiToolsOwnerModule = {};
  const unavailable = await piTools.preparePiManagedToolsForInstall(
    localOptions,
    { env: {} },
  );
  assert.match(unavailable.warnings[0], /fd_manager_unavailable/);
});

test("managed Pi tools normalize omitted user and home values", async () => {
  const env: NodeJS.ProcessEnv = {};
  const result = await piTools.preparePiManagedToolsForInstall(
    {
      currentUser: undefined,
      targetUser: undefined,
      targetHome: undefined,
      installDir: "/tmp/rin",
    } as any,
    {
      env,
      ensureTool: async (tool) => `/tmp/rin/bin/${tool}`,
    },
  );
  assert.equal(result.fd, "/tmp/rin/bin/fd");
  assert.equal(result.rg, "/tmp/rin/bin/rg");
  assert.deepEqual(env, {});
});

test("current-user preparation scopes HOME and agent dirs, then restores prior env", async () => {
  const env: NodeJS.ProcessEnv = {
    HOME: "/before/home",
    RIN_DIR: "/before/rin",
  };
  const observations: string[] = [];
  const result = await piTools.preparePiManagedToolsForInstall(localOptions, {
    env,
    ensureTool: async (tool, silent) => {
      observations.push(
        [
          tool,
          String(silent),
          env.HOME,
          env.RIN_DIR,
          env.PI_CODING_AGENT_DIR,
        ].join("|"),
      );
      return `/home/rin/.rin/bin/${tool}`;
    },
  });

  assert.deepEqual(result, {
    fd: "/home/rin/.rin/bin/fd",
    rg: "/home/rin/.rin/bin/rg",
    warnings: [],
  });
  assert.deepEqual(observations, [
    "fd|false|/home/rin|/home/rin/.rin|/home/rin/.rin",
    "rg|false|/home/rin|/home/rin/.rin|/home/rin/.rin",
  ]);
  assert.deepEqual(env, { HOME: "/before/home", RIN_DIR: "/before/rin" });
});

test("local optional tool failures stay warnings and preserve both failure details", async () => {
  const warnings: string[] = [];
  const result = await piTools.preparePiManagedToolsForInstall(
    { ...localOptions, targetUser: "" },
    {
      env: {},
      warn: (message) => warnings.push(message),
      ensureTool: async (tool) => {
        if (tool === "fd") throw new Error("fd registry unavailable");
        throw "rg registry unavailable";
      },
    },
  );

  assert.equal(result.fd, undefined);
  assert.equal(result.rg, undefined);
  assert.deepEqual(warnings, result.warnings);
  assert.ok(
    warnings.some((message) => message.includes("fd registry unavailable")),
  );
  assert.ok(
    warnings.some((message) => message.includes("rg registry unavailable")),
  );
  assert.ok(warnings.some((message) => message.includes("file autocomplete")));
  assert.ok(
    warnings.some((message) => message.includes("grep/search commands")),
  );
});

test("cross-user preparation requires both a command runner and target Node", async () => {
  const noRunnerWarnings: string[] = [];
  const noRunner = await piTools.preparePiManagedToolsForInstall(
    { ...localOptions, currentUser: "root", targetUser: "rin" },
    { warn: (message) => noRunnerWarnings.push(message) },
  );
  assert.deepEqual(noRunner.warnings, noRunnerWarnings);
  assert.match(noRunner.warnings[0], /command execution is unavailable/);

  const noNodeCalls: unknown[] = [];
  const noNode = await piTools.preparePiManagedToolsForInstall(
    { ...localOptions, currentUser: "root", targetUser: "rin" },
    {
      runCommandAsUser: (...args) => noNodeCalls.push(args),
    },
  );
  assert.deepEqual(noNodeCalls, []);
  assert.match(noNode.warnings[0], /target Node runtime is unavailable/);
});

test("cross-user preparation executes a self-contained target-runtime script", async () => {
  const calls: any[] = [];
  const result = await piTools.preparePiManagedToolsForInstall(
    {
      ...localOptions,
      currentUser: "root",
      targetUser: "rin",
      targetNodePath: "/opt/rin/node",
    },
    {
      toolsManagerModuleUrl: "file:///opt/rin/tools-manager.js",
      runCommandAsUser: (targetUser, command, args, env) =>
        calls.push({ targetUser, command, args, env }),
    },
  );

  assert.deepEqual(result, { warnings: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].targetUser, "rin");
  assert.equal(calls[0].command, "/opt/rin/node");
  assert.deepEqual(calls[0].args.slice(0, 2), ["--input-type=module", "-e"]);
  assert.match(calls[0].args[2], /file:\/\/\/opt\/rin\/tools-manager\.js/);
  assert.match(calls[0].args[2], /ensureTool\('fd', false\)/);
  assert.deepEqual(calls[0].env, {
    HOME: "/home/rin",
    RIN_DIR: "/home/rin/.rin",
    PI_CODING_AGENT_DIR: "/home/rin/.rin",
  });
});

test("cross-user command failures are reported without aborting installation", async () => {
  const warnings: string[] = [];
  const result = await piTools.preparePiManagedToolsForInstall(
    { ...localOptions, currentUser: "root", targetUser: "rin" },
    {
      nodePath: "/opt/rin/node",
      warn: (message) => warnings.push(message),
      runCommandAsUser: () => {
        throw "permission denied";
      },
    },
  );
  assert.deepEqual(result.warnings, warnings);
  assert.match(warnings[0], /for rin: permission denied/);
});

test("Windows uses in-process managed-tool preparation for another account", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  const ensureTool = mock.fn(async (tool: string) => `C:/Rin/${tool}.exe`);
  try {
    const result = await piTools.preparePiManagedToolsForInstall(
      { ...localOptions, currentUser: "Owner", targetUser: "Other" },
      { env: {}, ensureTool },
    );
    assert.equal(result.fd, "C:/Rin/fd.exe");
    assert.equal(result.rg, "C:/Rin/rg.exe");
    assert.equal(ensureTool.mock.callCount(), 2);
  } finally {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
  }
});
