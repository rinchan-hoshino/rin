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

async function withUpdaterEnv(fn: (stdout: string[]) => Promise<void>) {
  const keys = [
    "RIN_UPDATE_INSTALL_DIR",
    "RIN_UPDATE_TARGET_USER",
    "RIN_UPDATE_ASSUME_YES",
    "RIN_INSTALL_LANGUAGE",
  ] as const;
  const original = new Map<string, string | undefined>();
  const originalWrite = process.stdout.write;
  const stdout: string[] = [];
  for (const key of keys) original.set(key, process.env[key]);
  process.env.RIN_UPDATE_INSTALL_DIR = "/home/alice/.rin";
  process.env.RIN_UPDATE_TARGET_USER = "alice";
  process.env.RIN_UPDATE_ASSUME_YES = "true";
  process.stdout.write = ((chunk: any) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn(stdout);
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

test("startUpdater localizes zh_CN update notes beyond the confirm prompt", async () => {
  await withUpdaterEnv(async (stdout) => {
    process.env.RIN_UPDATE_ASSUME_YES = "true";

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
