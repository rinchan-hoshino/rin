import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const payload = await importBuiltModule<any>(
  "dist/core/rin-install/update-payload.js",
);

test("update payload parser owns update-only release arguments", () => {
  assert.deepEqual(payload.parseUpdatePayloadArgs([]).releaseRequest, {
    channel: "stable",
    branch: "",
    version: "",
    explicitReleaseChannel: false,
  });
  assert.deepEqual(payload.parseUpdatePayloadArgs(["--git"]).releaseRequest, {
    channel: "git",
    branch: "",
    version: "",
    explicitReleaseChannel: true,
  });
  assert.equal(
    payload.parseUpdatePayloadArgs(["--git", "owner-branch"]).releaseRequest
      .branch,
    "owner-branch",
  );
  assert.equal(
    payload.parseUpdatePayloadArgs(["--git=abcdef0"]).releaseRequest.version,
    "abcdef0",
  );
  assert.equal(
    payload.parseUpdatePayloadArgs(["--git=refs/tags/v1"]).releaseRequest
      .version,
    "refs/tags/v1",
  );
  assert.deepEqual(
    payload.parseUpdatePayloadArgs([
      "--target-user",
      "owner",
      "--install-dir=/owner/.rin",
      "--yes",
      "--preconfirmed",
      "--git=owner-branch",
    ]),
    {
      requestedTargetUser: "owner",
      requestedInstallDir: "/owner/.rin",
      assumeYes: true,
      preconfirmed: true,
      releaseFile: "",
      releaseRequest: {
        channel: "git",
        branch: "owner-branch",
        version: "",
        explicitReleaseChannel: true,
      },
    },
  );
  assert.equal(
    payload.parseUpdatePayloadArgs(["--git", "abcdef1"]).releaseRequest.version,
    "abcdef1",
  );
  assert.equal(
    payload.parseUpdatePayloadArgs(["--git", "refs/heads/main"]).releaseRequest
      .version,
    "refs/heads/main",
  );
  assert.equal(
    payload.parseUpdatePayloadArgs([
      "--git",
      "owner-branch",
      "--branch",
      "explicit",
    ]).releaseRequest.branch,
    "explicit",
  );
  assert.throws(
    () => payload.parseUpdatePayloadArgs(["--stable", "--beta"]),
    /rin_release_channel_conflict/,
  );
  assert.throws(
    () => payload.parseUpdatePayloadArgs(["--update"]),
    /unknown_run_option:--update/,
  );
});

test("update payload resolves one complete default dependency set", () => {
  const dependencies = payload.resolveUpdatePayloadDependencies();
  for (const value of Object.values(dependencies)) {
    assert.equal(typeof value, "function");
  }
});

test("update payload runs only through authorized shared updater semantics", async () => {
  const events: any[] = [];
  await payload.startUpdatePayload(
    [
      "--target-user",
      "owner",
      "--install-dir",
      "/owner/.rin",
      "--nightly",
      "--release-file",
      "/owner/release.json",
    ],
    {
      assertAuthorizedUpdateJob(installDir: string) {
        events.push(["authorized", installDir]);
      },
      detectExecutorUser: () => "executor",
      createInstallerCopy: () => ({
        installerCancelled: "cancelled",
        confirmActiveLabel: "yes",
        confirmInactiveLabel: "no",
      }),
      repoRootFromHere: () => "/owner/source",
      releaseInfoFromFile: (file: string) => ({ file }),
      isCancel: () => false,
      select: async () => "selected",
      confirm: async (options: any) => {
        events.push(["confirm", options]);
        return true;
      },
      async startUpdater(options: any) {
        events.push([
          "updater",
          options.detectCurrentUser(),
          options.repoRootFromHere(),
          options.ensureNotCancelled("ok"),
          options.release,
          options.releaseRequest,
          options.requestedInstallDir,
          options.requestedTargetUser,
          options.assumeYes,
          options.preconfirmed,
          await options.confirm({ message: "proceed" }),
          await options.select({ message: "target", options: [] }),
        ]);
      },
    },
  );
  assert.deepEqual(events[0], ["authorized", "/owner/.rin"]);
  const updaterEvent = events.find(([name]) => name === "updater");
  assert.ok(updaterEvent);
  assert.deepEqual(updaterEvent.slice(1, 6), [
    "executor",
    "/owner/source",
    "ok",
    { file: "/owner/release.json" },
    {
      channel: "nightly",
      branch: "",
      version: "",
      explicitReleaseChannel: true,
    },
  ]);
  assert.deepEqual(
    events.find(([name]) => name === "confirm"),
    ["confirm", { active: "yes", inactive: "no", message: "proceed" }],
  );
});

test("legacy prepared update handoff translates into the shared payload", async () => {
  const events: any[] = [];
  await payload.startLegacyPreparedUpdatePayload(
    [
      "--update",
      "--target-user",
      "owner",
      "--install-dir",
      "/owner/.rin",
      "--yes",
      "--preconfirmed",
      "--release-file",
      "/work/release.json",
    ],
    {
      assertAuthorizedUpdateJob() {
        events.push(["authorized"]);
      },
      detectExecutorUser: () => "owner",
      createInstallerCopy: () => ({
        installerCancelled: "cancelled",
        confirmActiveLabel: "yes",
        confirmInactiveLabel: "no",
      }),
      repoRootFromHere: () => "/work/src",
      releaseInfoFromFile: (file: string) => ({ file }),
      isCancel: () => false,
      select: async () => "selected",
      confirm: async () => true,
      async startUpdater(options: any) {
        events.push([
          "updater",
          options.release,
          options.requestedInstallDir,
          options.requestedTargetUser,
          options.assumeYes,
          options.preconfirmed,
        ]);
      },
    },
  );
  assert.deepEqual(events, [
    [
      "updater",
      { file: "/work/release.json" },
      "/owner/.rin",
      "owner",
      true,
      true,
    ],
  ]);

  const completeHandoff = [
    "--update",
    "--target-user",
    "owner",
    "--install-dir",
    "/owner/.rin",
    "--yes",
    "--preconfirmed",
    "--release-file",
    "/work/release.json",
  ];
  await assert.rejects(
    () =>
      payload.startLegacyPreparedUpdatePayload(completeHandoff, {
        repoRootFromHere: () => "/installed/current",
      }),
    /unknown_run_option:--update/,
  );
  await assert.rejects(
    () =>
      payload.startLegacyPreparedUpdatePayload(completeHandoff, {
        repoRootFromHere: () => "/other/src",
      }),
    /unknown_run_option:--update/,
  );
});

test("update payload preserves updater cancellation semantics", async () => {
  await assert.rejects(
    () =>
      payload.startUpdatePayload([], {
        assertAuthorizedUpdateJob() {},
        detectExecutorUser: () => "owner",
        createInstallerCopy: () => ({
          installerCancelled: "cancelled",
          confirmActiveLabel: "yes",
          confirmInactiveLabel: "no",
        }),
        releaseInfoFromFile: () => null,
        isCancel: () => true,
        cancel(message: string) {
          assert.equal(message, "cancelled");
        },
        exit(code: number): never {
          throw new Error(`exit:${code}`);
        },
        async startUpdater(options: any) {
          options.ensureNotCancelled(Symbol("cancel"));
        },
      }),
    /exit:1/,
  );
});
