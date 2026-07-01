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
      language: "zh_CN",
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
          language: "zh_CN",
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
      i18n: installerI18n.createInstallerI18n("en_US"),
      readInstalledUpdateLanguage: () => "",
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

test("startUpdater uses installed language for UI without rewriting settings", async () => {
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
        i18n: installerI18n.createInstallerI18n("en_US"),
        readInstalledUpdateLanguage: () => "zh_CN",
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
      installerI18n.createInstallerI18n("zh_CN").publishUpdateConfirmMessage,
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
      i18n: installerI18n.createInstallerI18n("en_US"),
      readInstalledUpdateLanguage: () => "",
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

test("startUpdater localizes zh_CN update notes beyond the confirm prompt", async () => {
  await withUpdaterStdout(async (stdout) => {
    await updater.startUpdater({
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
      i18n: installerI18n.createInstallerI18n("en_US"),
      readInstalledUpdateLanguage: () => "zh_CN",
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
    assert.match(output, /\u53d1\u73b0\u6765\u6e90: \u542f\u52a8\u5668/);
    assert.match(output, /\u7528\u6237\u4e3b\u76ee\u5f55: \/home\/alice/);
    assert.match(output, /\u8bf7\u6c42\u6765\u6e90: Git \u5206\u652f main/);
    assert.match(
      output,
      /\u5982\u5e73\u53f0\u652f\u6301\uff0c\u5c06\u4e3a\u6b64\u5b88\u62a4\u8fdb\u7a0b\u5b89\u88c5\u5e76\u542f\u52a8 Linux \u7528\u6237\u670d\u52a1/,
    );
    assert.doesNotMatch(
      output,
      /Owner home|Discovered from|Requested source|Service\/platform note|Linux user service will be installed/,
    );
  });
});
