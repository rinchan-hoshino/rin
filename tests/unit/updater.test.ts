import test from "node:test";
import assert from "node:assert/strict";
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

function fakeUpdateResult() {
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
  };
}

async function withUpdaterEnv(fn: () => Promise<void>) {
  const keys = [
    "RIN_UPDATE_INSTALL_DIR",
    "RIN_UPDATE_TARGET_USER",
    "RIN_UPDATE_ASSUME_YES",
    "RIN_INSTALL_LANGUAGE",
  ] as const;
  const original = new Map<string, string | undefined>();
  const originalWrite = process.stdout.write;
  for (const key of keys) original.set(key, process.env[key]);
  process.env.RIN_UPDATE_INSTALL_DIR = "/home/alice/.rin";
  process.env.RIN_UPDATE_TARGET_USER = "alice";
  process.env.RIN_UPDATE_ASSUME_YES = "true";
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
    for (const key of keys) {
      const value = original.get(key);
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("startUpdater does not write language during core updates", async () => {
  await withUpdaterEnv(async () => {
    let capturedOptions: any;

    await updater.startUpdater({
      detectCurrentUser: () => "alice",
      repoRootFromHere: () => "/src/rin",
      ensureNotCancelled: (value: unknown) => value,
      i18n: installerI18n.createInstallerI18n("en_US"),
      readInstalledUpdateLanguage: () => "",
      async runFinalizeInstallPlanInChild(options: any) {
        capturedOptions = options;
        return fakeUpdateResult();
      },
    });

    assert.equal(capturedOptions.currentUser, "alice");
    assert.equal(capturedOptions.targetUser, "alice");
    assert.equal(Object.hasOwn(capturedOptions, "language"), false);
  });
});

test("startUpdater uses installed language for UI without rewriting settings", async () => {
  await withUpdaterEnv(async () => {
    let capturedOptions: any;
    let confirmMessage = "";
    process.env.RIN_UPDATE_ASSUME_YES = "";

    await updater.startUpdater({
      detectCurrentUser: () => "alice",
      repoRootFromHere: () => "/src/rin",
      ensureNotCancelled: (value: unknown) => value,
      i18n: installerI18n.createInstallerI18n("en_US"),
      readInstalledUpdateLanguage: () => "zh_CN",
      async confirm(options: any) {
        confirmMessage = String(options.message || "");
        return true;
      },
      async runFinalizeInstallPlanInChild(options: any) {
        capturedOptions = options;
        return fakeUpdateResult();
      },
    });

    assert.equal(Object.hasOwn(capturedOptions, "language"), false);
    assert.equal(
      confirmMessage,
      installerI18n.createInstallerI18n("zh_CN").publishUpdateConfirmMessage,
    );
  });
});
