import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

await import("../support/register-rin-shared-owner-fixture.ts");
const shared = await import(
  pathToFileURL(path.resolve("dist/core/rin/shared.js")).href
);
const installPaths = await import(
  pathToFileURL(path.resolve("dist/core/rin-install/paths.js")).href
);
const owner = globalThis as any;

function parsed(overrides: Record<string, unknown> = {}) {
  return {
    targetUser: os.userInfo().username,
    installDir: "",
    updateAssumeYes: false,
    explicitReleaseChannel: false,
    releaseChannel: "stable",
    releaseBranch: "",
    releaseVersion: "",
    ...overrides,
  } as any;
}

test("Rin shared boundary owns target reads, execution context, daemon readiness, release preference, and updater launch", async () => {
  owner.__rinSharedOwnerEvents = [];
  owner.__rinSharedOwnerExec = undefined;
  owner.__rinSharedOwnerConnectValues = [];
  owner.__rinSharedOwnerConnect = false;
  owner.__rinSharedOwnerRequestFailure = false;
  owner.__rinSharedOwnerSystemdUnit = "";

  const captured = shared.captureInternalRinCommand(
    {
      repoRoot: "/repo/owner",
      capture(argv: string[]) {
        owner.__rinSharedOwnerEvents.push(["capture-internal", argv]);
        return "owner-output";
      },
    },
    "__owner_internal",
    ["status", "--json", "--target", "remote"],
    "status",
  );
  assert.equal(captured, "owner-output");
  assert.deepEqual(owner.__rinSharedOwnerEvents.at(-1), [
    "capture-internal",
    [
      process.execPath,
      "/repo/owner/dist/app/rin/main.js",
      "__owner_internal",
      "--json",
    ],
  ]);

  const localReads: unknown[][] = [];
  assert.deepEqual(
    shared.readTargetJsonFile(
      "/owner/local.json",
      { fallback: true },
      {
        targetUser: "same",
        currentUser: "same",
        readJson(filePath: string, fallback: unknown) {
          localReads.push([filePath, fallback]);
          return { local: true };
        },
        readPrivilegedJson() {
          throw new Error("unexpected privileged read");
        },
      },
    ),
    { local: true },
  );
  assert.deepEqual(localReads, [["/owner/local.json", { fallback: true }]]);
  assert.deepEqual(
    shared.readTargetJsonFile("/owner/missing-default.json", {
      fallback: true,
    }),
    { fallback: true },
  );
  assert.deepEqual(
    shared.readTargetJsonFile(
      "/owner/cross.json",
      {},
      {
        targetUser: "target",
        currentUser: "operator",
        readJson() {
          throw new Error("unexpected local read");
        },
        readPrivilegedJson(filePath: string, fallback: unknown) {
          return { filePath, fallback, privileged: true };
        },
      },
    ),
    { filePath: "/owner/cross.json", fallback: {}, privileged: true },
  );

  owner.__rinSharedOwnerPrivilegedValue = {
    language: "zh_CN",
    currentRelease: { release: { channel: "git", branch: "owner-branch" } },
  };
  const updateI18n = shared.createUpdateI18n();
  assert.equal(typeof updateI18n.introTitle, "string");
  assert.equal(Object.hasOwn(updateI18n, "displayLanguage"), false);
  owner.__rinSharedOwnerPrivilegedValue = {};
  owner.__rinSharedOwnerPrivilegedValue = {
    language: "zh_CN",
    currentRelease: { release: { channel: "git", branch: "owner-branch" } },
  };
  assert.deepEqual(
    shared.readInstallerManifestForTarget("/home/target/.rin", {
      targetUser: "target",
      currentUser: "operator",
    }),
    owner.__rinSharedOwnerPrivilegedValue,
  );

  const currentUser = os.userInfo().username;
  assert.equal(
    shared.resolveRuntimeAgentDirForTarget(
      currentUser,
      currentUser,
      "/install",
      {
        RIN_DIR: "/explicit-owner",
      },
    ),
    "/explicit-owner",
  );
  assert.equal(
    shared.resolveRuntimeAgentDirForTarget("", currentUser, "/install", {
      RIN_DIR: "/explicit-empty-target",
    }),
    "/explicit-empty-target",
  );
  assert.equal(
    shared.resolveRuntimeAgentDirForTarget("other", currentUser, "/install", {
      RIN_DIR: "/must-not-win",
    }),
    "/install",
  );
  assert.equal(
    shared.resolveRuntimeAgentDirForTarget("other", currentUser, "", {
      RIN_DIR: "/cross-fallback",
    }),
    "/cross-fallback",
  );

  owner.__rinSharedOwnerConnect = true;
  owner.__rinSharedOwnerRequestValue = { status: "owner-ready" };
  const localContext = shared.createTargetExecutionContext(
    parsed({ targetUser: currentUser }),
  );
  assert.equal(localContext.currentUser, currentUser);
  assert.equal(localContext.isTargetUser, true);
  assert.equal(localContext.repoRoot, "/repo-owner");
  assert.equal(localContext.installDir, `/home/${currentUser}/.rin`);
  assert.equal(localContext.agentDir, `/home/${currentUser}/.rin`);
  assert.equal(localContext.socketPath, `/socket/${currentUser}`);
  localContext.exec(["owner", "exec"]);
  assert.equal(localContext.capture(["owner", "capture"]), "owner-capture");
  assert.equal(await localContext.canConnectSocket(), true);
  assert.deepEqual(await localContext.queryDaemonStatus(), {
    status: "owner-ready",
  });
  owner.__rinSharedOwnerRequestFailure = true;
  assert.equal(await localContext.queryDaemonStatus(), undefined);
  owner.__rinSharedOwnerRequestFailure = false;

  const crossContext = shared.createTargetExecutionContext(
    parsed({ targetUser: "target", installDir: "/srv/owner" }),
  );
  assert.equal(crossContext.isTargetUser, false);
  assert.equal(crossContext.socketPath, "/socket/target");
  owner.__rinSharedOwnerExec = (_command: string, args: string[]) => {
    const script = String(args[2] || "");
    if (script.startsWith("probe:")) return "";
    if (script.startsWith("status:")) return '{"status":"cross-owner"}';
    return "owner-shell-output";
  };
  assert.equal(await crossContext.canConnectSocket(), true);
  assert.deepEqual(await crossContext.queryDaemonStatus(), {
    status: "cross-owner",
  });
  owner.__rinSharedOwnerExec = () => {
    throw new Error("cross owner unavailable");
  };
  assert.equal(await crossContext.canConnectSocket(), false);
  assert.equal(await crossContext.queryDaemonStatus(), undefined);
  owner.__rinSharedOwnerExec = () => "null";
  assert.equal(await crossContext.queryDaemonStatus(), undefined);
  owner.__rinSharedOwnerExec = () => "not-json";
  assert.equal(await crossContext.queryDaemonStatus(), undefined);
  owner.__rinSharedOwnerExec = undefined;

  assert.equal(
    shared.targetPathExists(
      { isTargetUser: true, capture() {} },
      "/owner/path",
      (filePath: string) => filePath === "/owner/path",
    ),
    true,
  );
  assert.equal(
    shared.targetPathExists(
      { isTargetUser: true, capture() {} },
      "/missing",
      () => false,
    ),
    false,
  );
  assert.equal(
    shared.targetPathExists(
      { isTargetUser: false, capture() {} },
      "/cross/path",
    ),
    true,
  );
  assert.equal(
    shared.targetPathExists(
      {
        isTargetUser: false,
        capture() {
          throw new Error("missing");
        },
      },
      "/cross/missing",
    ),
    false,
  );

  const readyCalls: string[] = [];
  await shared.assertDaemonAvailable({
    canConnectSocket: async () => true,
    targetUser: "owner",
  } as any);
  owner.__rinSharedOwnerSystemdUnit = "owner.service";
  await assert.rejects(
    () =>
      shared.assertDaemonAvailable({
        canConnectSocket: async () => false,
        systemctl: "/usr/bin/systemctl",
        managedServiceUnits: ["owner.service"],
        exec(argv: string[]) {
          readyCalls.push(argv.join(" "));
        },
        targetUser: "owner",
      } as any),
    /rin_daemon_unavailable.*owner/,
  );
  assert.deepEqual(readyCalls, []);
  await assert.rejects(
    () =>
      shared.assertDaemonAvailable({
        canConnectSocket: async () => false,
        systemctl: "",
        targetUser: "missing-owner",
      } as any),
    /rin_daemon_unavailable.*missing-owner/,
  );

  assert.equal(
    shared.resolveInstallDirForTarget(parsed({ targetUser: "target" })),
    "/home/target/.rin",
  );
  assert.equal(
    shared.resolveInstallDirForTarget(
      parsed({ targetUser: "missing", installDir: "/explicit/install" }),
    ),
    "/explicit/install",
  );

  owner.__rinSharedOwnerPrivilegedValue = {
    currentRelease: { release: { channel: "stable", branch: "ignored" } },
  };
  assert.deepEqual(
    shared.readInstalledUpdateReleasePreference("/srv/owner", {
      targetUser: "target",
      currentUser: "operator",
    }),
    { channel: "stable", branch: "" },
  );
  owner.__rinSharedOwnerPrivilegedValue = {
    currentRelease: { release: { channel: "git", branch: " owner-main " } },
  };
  assert.deepEqual(
    shared.readInstalledUpdateReleasePreference("/srv/owner", {
      targetUser: "target",
      currentUser: "operator",
    }),
    { channel: "git", branch: "owner-main" },
  );
  owner.__rinSharedOwnerPrivilegedValue = {
    currentRelease: { release: { channel: "invalid" } },
  };
  assert.throws(
    () =>
      shared.readInstalledUpdateReleasePreference("/srv/owner", {
        targetUser: "target",
        currentUser: "operator",
      }),
    /rin_update_installed_release_channel_missing/,
  );

  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-shared-update-owner-"),
  );
  try {
    const managedNode = installPaths.managedNodeExecutablePath(installDir);
    await fs.mkdir(path.dirname(managedNode), { recursive: true });
    await fs.writeFile(managedNode, "owner node", "utf8");
    assert.equal(shared.rinInstallUpdateNodeCommand(installDir), managedNode);
    assert.throws(
      () =>
        shared.rinInstallUpdateNodeCommand(path.join(installDir, "missing")),
      /rin_managed_node_runtime_missing/,
    );

    await shared.runUpdate(
      parsed({
        targetUser: "target",
        installDir,
        updateAssumeYes: true,
        explicitReleaseChannel: true,
        releaseChannel: "git",
        releaseBranch: "owner-branch",
        releaseVersion: "owner-ref",
      }),
    );
    const jobsDir = path.join(installDir, "data", "core", "updates", "jobs");
    const [jobFile] = await fs.readdir(jobsDir);
    const jobPath = path.join(jobsDir, jobFile);
    const launchEvent = owner.__rinSharedOwnerEvents.findLast(
      ([name]: string[]) => name === "spawn",
    );
    assert.equal(launchEvent[1], managedNode);
    assert.deepEqual(launchEvent[2], [
      "/repo-owner/dist/app/rin-install/update-job.js",
      jobPath,
    ]);
    const job = JSON.parse(await fs.readFile(jobPath, "utf8"));
    assert.equal(job.command, managedNode);
    assert.deepEqual(job.args, [
      "/repo-owner/dist/app/rin-install/update-payload.js",
      "--target-user",
      "target",
      "--install-dir",
      installDir,
      "--yes",
      "--git",
      "--branch",
      "owner-branch",
      "--version",
      "owner-ref",
    ]);

    const eventCountBeforeRejectedUpdate = owner.__rinSharedOwnerEvents.length;
    await assert.rejects(
      () =>
        shared.runUpdate(parsed({ targetUser: "target", installDir }), {
          stdinIsTTY: false,
          stdoutIsTTY: false,
        }),
      /rin_update_confirmation_required: pass --yes in non-interactive mode/,
    );
    assert.equal(
      owner.__rinSharedOwnerEvents.length,
      eventCountBeforeRejectedUpdate,
    );
    assert.deepEqual(await fs.readdir(jobsDir), [jobFile]);

    owner.__rinSharedOwnerSpawnResult = { code: 5, signal: null };
    await assert.rejects(
      () =>
        shared.runUpdate(parsed({ targetUser: "target", installDir }), {
          stdinIsTTY: true,
          stdoutIsTTY: true,
        }),
      /rin_child_command_failed:5/,
    );
    owner.__rinSharedOwnerSpawnResult = { code: null, signal: "SIGTERM" };
    await assert.rejects(
      () =>
        shared.runUpdate(parsed({ targetUser: "target", installDir }), {
          stdinIsTTY: true,
          stdoutIsTTY: true,
        }),
      /rin_process_termination_requested:143/,
    );
    owner.__rinSharedOwnerSpawnResult = { code: 0, signal: null };
  } finally {
    await fs.rm(installDir, { recursive: true, force: true });
  }
});
