import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
await import("../support/register-updater-private-owner-fixture.ts");
const updater = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "updater.js"))
    .href
);
const installerI18n = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "i18n.js"))
    .href
);

test("updater private release readers preserve installed channel preferences", async () => {
  const owner = updater as typeof updater & {
    __rinOwnerDefaultReadInstalledRelease(target: {
      currentUser: string;
      targetUser: string;
      installDir: string;
    }): unknown;
    __rinOwnerReadInstalledReleasePreference(
      installedRelease: unknown,
    ): { channel: string; branch: string } | null;
  };
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-updater-release-reader-"),
  );
  try {
    await fs.writeFile(
      path.join(installDir, "installer.json"),
      JSON.stringify({
        currentRelease: {
          release: { channel: "git", branch: " owner-branch " },
        },
      }),
    );
    assert.deepEqual(
      owner.__rinOwnerDefaultReadInstalledRelease({
        currentUser: "owner",
        targetUser: "owner",
        installDir,
      }),
      { channel: "git", branch: " owner-branch " },
    );
    assert.equal(
      owner.__rinOwnerDefaultReadInstalledRelease({
        currentUser: "owner",
        targetUser: "owner",
        installDir: path.join(installDir, "missing"),
      }),
      null,
    );
    assert.deepEqual(
      owner.__rinOwnerReadInstalledReleasePreference({
        channel: " stable ",
      }),
      { channel: "stable", branch: "" },
    );
    assert.deepEqual(
      owner.__rinOwnerReadInstalledReleasePreference({
        channel: "git",
        branch: " owner-branch ",
      }),
      { channel: "git", branch: "owner-branch" },
    );
    assert.equal(
      owner.__rinOwnerReadInstalledReleasePreference({ channel: "owner" }),
      null,
    );
    const previousJobPath = process.env.RIN_UPDATE_JOB_PATH;
    const previousJobId = process.env.RIN_UPDATE_JOB_ID;
    process.env.RIN_UPDATE_JOB_PATH = "/owner/job.json";
    process.env.RIN_UPDATE_JOB_ID = "owner-job";
    let forwardedEnv: Record<string, string> | undefined;
    let targetCommand: any;
    try {
      targetCommand = updater.buildTargetUserUpdaterCommand(
        {
          sourceRoot: "/owner/source",
          targetUser: "owner-target",
          ownerHome: "/owner/home",
          installDir: "/owner/install",
          release: {
            channel: "git",
            version: "1.2.3",
            branch: "owner-branch",
            ref: "owner-ref",
            repoUrl: "https://example.invalid/owner.git",
          },
        },
        {
          commandAsUserInvocation(targetUser, command, args, env) {
            forwardedEnv = env;
            return { command, args: [targetUser, ...args], options: { env } };
          },
        },
      );
    } finally {
      if (previousJobPath === undefined) delete process.env.RIN_UPDATE_JOB_PATH;
      else process.env.RIN_UPDATE_JOB_PATH = previousJobPath;
      if (previousJobId === undefined) delete process.env.RIN_UPDATE_JOB_ID;
      else process.env.RIN_UPDATE_JOB_ID = previousJobId;
    }
    assert.deepEqual(forwardedEnv, {
      HOME: "/owner/home",
      RIN_UPDATE_JOB_PATH: "/owner/job.json",
      RIN_UPDATE_JOB_ID: "owner-job",
    });
    assert.match(targetCommand.command, /node$/);
    assert.equal(targetCommand.args[0], "owner-target");
    assert.deepEqual(targetCommand.args.slice(-2), ["--version", "owner-ref"]);
    assert.equal(targetCommand.options.cwd, "/owner/source");
  } finally {
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

function fakeUpdateResult(overrides: Record<string, unknown> = {}) {
  return {
    written: {
      launcherPath: "/home/alice/.config/rin/install.json",
      rinPath: "/home/alice/.local/bin/rin",
      rinInstallPath: "/home/alice/.local/bin/rin-install",
    },
    publishedRuntime: {
      currentLink: "/home/alice/.rin/app/current",
      releaseRoot: "/home/alice/.rin/app/releases/test",
    },
    installedDocs: { pi: [] },
    installedDocsDir: "/home/alice/.rin/docs/rin",
    installedService: null,
    daemonReady: false,
    serviceHint: "",
    prunedReleases: { removed: [] },
    ...overrides,
  };
}

async function withUpdaterStdout(fn: (stdout: string[]) => Promise<void>) {
  const originalWrite = process.stdout.write;
  const stdout: string[] = [];
  process.stdout.write = ((chunk: any) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn(stdout);
  } finally {
    process.stdout.write = originalWrite;
  }
}

const requestedUpdateTarget = {
  requestedInstallDir: "/home/alice/.rin",
  requestedTargetUser: "alice",
};
const preparedRelease = {
  channel: "stable",
  archiveUrl: "https://example.test/rin.tgz",
  version: "1.2.3",
  branch: "stable",
  ref: "abc1234",
  sourceLabel: "stable 1.2.3",
};

test("buildPreparedUpdaterCommand launches prepared managed node", async () => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rin-updater-"));
  try {
    const managedNode = path.join(
      sourceRoot,
      "runtime",
      "node",
      "current",
      process.platform === "win32" ? "node.exe" : "bin/node",
    );
    await fs.mkdir(path.dirname(managedNode), { recursive: true });
    await fs.writeFile(managedNode, "#!/bin/sh\n", { mode: 0o755 });
    const command = updater.buildPreparedUpdaterCommand({
      sourceRoot,
      releaseFile: path.join(sourceRoot, "release.json"),
      currentUser: "alice",
      targetUser: "alice",
      installDir: "/home/alice/.rin",
    });

    assert.equal(command.command, managedNode);
    assert.deepEqual(command.args.slice(0, 2), [
      path.join(sourceRoot, "dist", "app", "rin-install", "update-payload.js"),
      "--target-user",
    ]);
    assert.equal(command.options.cwd, sourceRoot);
  } finally {
    await fs.rm(sourceRoot, { recursive: true, force: true });
  }
});

test("buildPreparedUpdaterCommand requires prepared managed node", async () => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rin-updater-"));
  try {
    assert.throws(
      () =>
        updater.buildPreparedUpdaterCommand({
          sourceRoot,
          releaseFile: path.join(sourceRoot, "release.json"),
          currentUser: "alice",
          targetUser: "alice",
          installDir: "/home/alice/.rin",
        }),
      /rin_managed_node_runtime_missing/,
    );
  } finally {
    await fs.rm(sourceRoot, { recursive: true, force: true });
  }
});

test("startUpdater does not write language during core updates", async () => {
  await withUpdaterStdout(async () => {
    let capturedOptions: any;

    await updater.startUpdater({
      detectCurrentUser: () => "alice",
      repoRootFromHere: () => "/src/rin",
      ensureNotCancelled: (value: unknown) => value,
      i18n: installerI18n.createInstallerI18n(),
      release: preparedRelease,
      ...requestedUpdateTarget,
      assumeYes: true,
      async runFinalizeInstallPlanInChild(options: any) {
        capturedOptions = options;
        return fakeUpdateResult();
      },
    });

    assert.equal(capturedOptions.currentUser, "alice");
    assert.equal(capturedOptions.targetUser, "alice");
    assert.equal(Object.hasOwn(capturedOptions, "language"), false);
    assert.equal(capturedOptions.coreUpdate, true);
  });
});

test("startUpdater reinstalls an already-current release", async () => {
  await withUpdaterStdout(async (stdout) => {
    let capturedOptions: any;

    await updater.startUpdater({
      detectCurrentUser: () => "alice",
      repoRootFromHere: () => "/src/rin",
      ensureNotCancelled: (value: unknown) => value,
      i18n: installerI18n.createInstallerI18n(),
      release: preparedRelease,
      ...requestedUpdateTarget,
      assumeYes: true,
      readInstalledRelease: () => preparedRelease,
      async runFinalizeInstallPlanInChild(options: any) {
        capturedOptions = options;
        return fakeUpdateResult();
      },
    });

    assert.equal(capturedOptions.reinstallCurrentRelease, true);
    assert.equal(capturedOptions.coreUpdate, true);
    assert.match(stdout.join(""), /Reinstalling current version/);
    assert.match(stdout.join(""), /restore managed runtime files/);
  });
});

test("startUpdater uses fixed English UI without writing language", async () => {
  await withUpdaterStdout(async () => {
    let capturedOptions: any;
    let confirmMessage = "";
    const originalStdinIsTty = process.stdin.isTTY;
    const originalStdoutIsTty = process.stdout.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });

    try {
      await updater.startUpdater({
        detectCurrentUser: () => "alice",
        repoRootFromHere: () => "/src/rin",
        ensureNotCancelled: (value: unknown) => value,
        i18n: installerI18n.createInstallerI18n(),
        release: preparedRelease,
        ...requestedUpdateTarget,
        async confirm(options: any) {
          confirmMessage = String(options.message || "");
          return true;
        },
        async runFinalizeInstallPlanInChild(options: any) {
          capturedOptions = options;
          return fakeUpdateResult();
        },
      });
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: originalStdinIsTty,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: originalStdoutIsTty,
      });
    }

    assert.equal(Object.hasOwn(capturedOptions, "language"), false);
    assert.equal(
      confirmMessage,
      installerI18n.createInstallerI18n().publishUpdateConfirmMessage,
    );
  });
});

test("startUpdater skips repeated plan and confirmation when preconfirmed", async () => {
  await withUpdaterStdout(async (stdout) => {
    let confirmCalled = false;
    let capturedOptions: any;

    await updater.startUpdater({
      detectCurrentUser: () => "alice",
      repoRootFromHere: () => "/src/rin",
      ensureNotCancelled: (value: unknown) => value,
      i18n: installerI18n.createInstallerI18n(),
      release: preparedRelease,
      ...requestedUpdateTarget,
      preconfirmed: true,
      async confirm() {
        confirmCalled = true;
        return true;
      },
      async runFinalizeInstallPlanInChild(options: any) {
        capturedOptions = options;
        return fakeUpdateResult();
      },
    });

    const output = stdout.join("");
    assert.equal(confirmCalled, false);
    assert.equal(capturedOptions.coreUpdate, true);
    assert.doesNotMatch(output, /Update targets|Update plan/);
    assert.match(output, /Written paths/);
  });
});

test("startUpdater rejects unresolved git metadata before publishing", async () => {
  await withUpdaterStdout(async () => {
    let finalizeCalled = false;
    await assert.rejects(
      updater.startUpdater({
        detectCurrentUser: () => "alice",
        repoRootFromHere: () => "/src/rin",
        ensureNotCancelled: (value: unknown) => value,
        release: {
          channel: "git",
          archiveUrl: "https://example.test/rin.tar.gz",
          version: "main",
          branch: "main",
          ref: "main",
          sourceLabel: "git branch main",
        },
        i18n: installerI18n.createInstallerI18n(),
        ...requestedUpdateTarget,
        assumeYes: true,
        async runFinalizeInstallPlanInChild() {
          finalizeCalled = true;
          return fakeUpdateResult();
        },
      }),
      /rin_git_ref_not_resolved:main/,
    );
    assert.equal(finalizeCalled, false);
  });
});

test("startUpdater renders update notes in fixed English", async () => {
  await withUpdaterStdout(async (stdout) => {
    await updater.startUpdater({
      detectCurrentUser: () => "alice",
      repoRootFromHere: () => "/src/rin",
      ensureNotCancelled: (value: unknown) => value,
      release: {
        channel: "git",
        archiveUrl: "https://example.test/rin.tar.gz",
        version: "0123456789ab",
        branch: "main",
        ref: "0123456789abcdef0123456789abcdef01234567",
        sourceLabel: "git branch main @ 0123456789ab",
      },
      i18n: installerI18n.createInstallerI18n(),
      ...requestedUpdateTarget,
      assumeYes: true,
      async runFinalizeInstallPlanInChild() {
        return fakeUpdateResult({
          serviceHint:
            "A Linux user service will be installed and started for this daemon when supported.",
        });
      },
    });

    const output = stdout.join("");
    assert.match(output, /Discovered from: launcher/);
    assert.match(output, /Owner home: \/home\/alice/);
    assert.match(output, /Requested source: git branch main/);
    assert.match(output, /Service\/platform note: A Linux user service/);
    assert.doesNotMatch(output, /[\u3400-\u9fff]/u);
  });
});
