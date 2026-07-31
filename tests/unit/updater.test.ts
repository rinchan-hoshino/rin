import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const updater = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "updater.js"))
    .href
);
const installerI18n = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "i18n.js"))
    .href
);

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
    assert.deepEqual(command.args.slice(0, 3), [
      path.join(sourceRoot, "dist", "app", "rin-install", "main.js"),
      "--update",
      "--target-user",
    ]);
    assert.equal(command.options.cwd, sourceRoot);
  } finally {
    await fs.rm(sourceRoot, { recursive: true, force: true });
  }
});

test("buildTargetUserUpdaterCommand delegates the complete updater entry", () => {
  const calls: any[] = [];
  const command = updater.buildTargetUserUpdaterCommand(
    {
      sourceRoot: "/opt/rin/source",
      targetUser: "alice",
      ownerHome: "/home/alice",
      installDir: "/home/alice/.rin",
      release: {
        ...preparedRelease,
        channel: "git",
        branch: "main",
        ref: "3347b88f",
      },
    },
    {
      commandAsUserInvocation: (
        targetUser: string,
        executable: string,
        args: string[],
        env: Record<string, string>,
      ) => {
        calls.push({ targetUser, executable, args, env });
        return { command: "run-as-alice", args: [executable, ...args] };
      },
    },
  );

  assert.deepEqual(calls, [
    {
      targetUser: "alice",
      executable: path.join(
        "/home/alice/.rin",
        "runtime",
        "node",
        "current",
        process.platform === "win32" ? "node.exe" : "bin/node",
      ),
      args: [
        path.join("/opt/rin/source", "dist", "app", "rin-install", "main.js"),
        "--update",
        "--target-user",
        "alice",
        "--install-dir",
        "/home/alice/.rin",
        "--yes",
        "--preconfirmed",
        "--release-channel",
        "git",
        "--version",
        "3347b88f",
      ],
      env: { HOME: "/home/alice" },
    },
  ]);
  assert.equal(command.command, "run-as-alice");
  assert.equal(command.options.cwd, "/opt/rin/source");
});

test("startUpdater hands off before creating the update workspace", async (t) => {
  if (process.platform === "win32") {
    t.skip("cross-user delegation is Unix-specific");
    return;
  }
  await withUpdaterStdout(async () => {
    const handoffs: any[] = [];
    await updater.startUpdater({
      detectCurrentUser: () => "root",
      repoRootFromHere: () => "/opt/rin/source",
      ensureNotCancelled: (value: unknown) => value,
      i18n: installerI18n.createInstallerI18n(),
      requestedInstallDir: "/home/alice/.rin",
      requestedTargetUser: "alice",
      assumeYes: true,
      preconfirmed: true,
      readInstalledRelease: () => null,
      resolveUpdateRelease: async () => preparedRelease,
      runTargetUserUpdater: async (options: any) => {
        handoffs.push(options);
      },
    });

    assert.deepEqual(handoffs, [
      {
        sourceRoot: "/opt/rin/source",
        targetUser: "alice",
        ownerHome: "/home/alice",
        installDir: "/home/alice/.rin",
        release: preparedRelease,
      },
    ]);
  });
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
