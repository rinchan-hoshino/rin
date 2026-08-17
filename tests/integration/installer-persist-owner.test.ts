import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  installAuthPath,
  installerManifestPaths,
  installSettingsPath,
} from "../../dist/core/rin-install/paths.js";

await import("../support/register-persist-owner-fixture.ts");
const persistOwner = await import("../../dist/core/rin-install/persist.js");
const {
  applyInstallUpgradeMigrations,
  finalizeInstallUpgradeMigrations,
  normalizeInstalledSettings,
  persistInstallerOutputs,
  preflightInstallUpgradeMigrations,
  reconcileInstallerManifest,
  rollbackInstallUpgradeMigrations,
} = persistOwner;

async function withInstallRoot(run: (root: string) => Promise<void>) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rin-persist-owner-"));
  try {
    await run(root);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson<T = any>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

test("persist private file helpers preserve elevated and owner-local boundaries", async () => {
  const owner = persistOwner as any;
  const writes: unknown[][] = [];
  owner.__rinOwnerWriteInstallerJson(
    "/owner/elevated.json",
    { owner: true },
    { elevated: true, ownerUser: "alice", ownerGroup: 42 },
    {
      writeJsonFileWithPrivilege: (...args: unknown[]) => writes.push(args),
      writeJsonFile: (...args: unknown[]) => writes.push(args),
    },
  );
  owner.__rinOwnerWriteInstallerJson(
    "/owner/local.json",
    { owner: false },
    {},
    {
      writeJsonFileWithPrivilege: (...args: unknown[]) => writes.push(args),
      writeJsonFile: (...args: unknown[]) => writes.push(args),
    },
  );
  assert.deepEqual(writes, [
    ["/owner/elevated.json", { owner: true }, "alice", 42],
    ["/owner/local.json", { owner: false }],
  ]);

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rin-persist-helper-"));
  try {
    const localFile = path.join(root, "local");
    await fsp.writeFile(localFile, "owner");
    owner.__rinOwnerRemoveFile(localFile, false, () => {});
    assert.equal(fs.existsSync(localFile), false);
    const removals: unknown[][] = [];
    owner.__rinOwnerRemoveFile(
      "/owner/elevated",
      true,
      (...args: unknown[]) => {
        removals.push(args);
      },
    );
    owner.__rinOwnerRemoveFile("/owner/ignored", true, () => {
      throw new Error("ignored cleanup failure");
    });
    assert.deepEqual(removals, [["rm", ["-f", "/owner/elevated"]]]);

    const dirs: string[] = [];
    owner.__rinOwnerEnsureRuntimeUserDirs(
      { targetUser: "alice", installDir: root },
      { ensureDir: (dir: string) => dirs.push(dir) },
    );
    const commands: unknown[][] = [];
    owner.__rinOwnerEnsureRuntimeUserDirs(
      { targetUser: "alice", installDir: root, elevated: true },
      {
        ensureDir: (dir: string) => dirs.push(dir),
        runCommandAsUser: (...args: unknown[]) => commands.push(args),
      },
    );
    assert.deepEqual(dirs, [path.join(root, "self_improve", "skills")]);
    assert.deepEqual(commands, [
      ["alice", "mkdir", ["-p", path.join(root, "self_improve", "skills")]],
    ]);

    const migrationCommands: unknown[][] = [];
    const migrationDeps = {
      runCommandAsUser: (...args: unknown[]) => migrationCommands.push(args),
    };
    const migrationOptions = { targetUser: "alice", elevated: true };
    owner.__rinOwnerWriteTextFileAsTargetUser(
      path.join(root, "elevated", "owner.txt"),
      "owner",
      migrationOptions,
      migrationDeps,
    );
    const localOps = owner.__rinOwnerCreateSchemaMigrationFileOps(
      { targetUser: "alice" },
      {},
    );
    const source = path.join(root, "source.json");
    const renamed = path.join(root, "renamed.json");
    localOps.writeJsonObject(source, { owner: true });
    assert.equal(localOps.pathExists(source), true);
    assert.equal(localOps.pathExists(path.join(root, "missing")), false);
    assert.deepEqual(localOps.readJsonObject(source), { owner: true });
    assert.equal(localOps.readJsonObject(path.join(root, "missing")), null);
    localOps.ensureDir(path.join(root, "local-dir"));
    localOps.rename(source, renamed);
    localOps.remove(renamed);
    assert.equal(fs.existsSync(renamed), false);

    const elevatedOps = owner.__rinOwnerCreateSchemaMigrationFileOps(
      migrationOptions,
      migrationDeps,
    );
    elevatedOps.writeJsonObject(path.join(root, "remote.json"), {
      elevated: true,
    });
    elevatedOps.ensureDir(path.join(root, "remote-dir"));
    elevatedOps.rename("/owner/from", "/owner/to");
    elevatedOps.remove("/owner/remove");
    assert.equal(migrationCommands.length, 7);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("persist private normalizers reject malformed objects and fill owner defaults", () => {
  const owner = persistOwner as typeof persistOwner & {
    __rinOwnerParseJsonObject(text: string): Record<string, unknown> | null;
    __rinOwnerResolveInstallOwner(
      targetUser: string,
      findSystemUser: (targetUser: string) => unknown,
    ): { ownerUser: string; ownerGroup?: number; ownerHome: string };
    __rinOwnerNormalizeManagedFilesManifest(
      value: unknown,
    ): { trees: Record<string, string[]> } | undefined;
    __rinOwnerMergeManagedFilesManifests(
      prior: { trees: Record<string, string[]> } | undefined,
      next: { trees: Record<string, string[]> } | undefined,
    ): { trees: Record<string, string[]> } | undefined;
  };
  assert.deepEqual(owner.__rinOwnerParseJsonObject('{"owner":true}'), {
    owner: true,
  });
  assert.equal(owner.__rinOwnerParseJsonObject("[]"), null);
  assert.equal(owner.__rinOwnerParseJsonObject("null"), null);
  assert.equal(owner.__rinOwnerParseJsonObject("1"), null);

  const fallback = owner.__rinOwnerResolveInstallOwner("alice", () => null);
  assert.equal(fallback.ownerUser, "alice");
  assert.equal(fallback.ownerGroup, undefined);
  assert.match(fallback.ownerHome, /alice$/);
  assert.deepEqual(
    owner.__rinOwnerResolveInstallOwner("alice", () => ({
      name: "bob",
      gid: 42,
      home: "/owner/home",
    })),
    { ownerUser: "bob", ownerGroup: 42, ownerHome: "/owner/home" },
  );
  const partialOwner = owner.__rinOwnerResolveInstallOwner("alice", () => ({
    name: "",
    gid: undefined,
    home: "",
  }));
  assert.equal(partialOwner.ownerUser, "alice");
  assert.equal(partialOwner.ownerGroup, undefined);
  assert.match(partialOwner.ownerHome, /alice$/);

  assert.equal(owner.__rinOwnerNormalizeManagedFilesManifest(null), undefined);
  assert.equal(owner.__rinOwnerNormalizeManagedFilesManifest({}), undefined);
  assert.equal(
    owner.__rinOwnerNormalizeManagedFilesManifest({ trees: {} }),
    undefined,
  );
  const normalized = owner.__rinOwnerNormalizeManagedFilesManifest({
    trees: {
      "/absolute": ["owner"],
      ".": ["owner"],
      ignored: null,
      valid: ["", "/absolute", ".", "b", "b", "a\\c"],
    },
  });
  assert.deepEqual(normalized, { trees: { valid: ["a/c", "b"] } });
  assert.equal(
    owner.__rinOwnerMergeManagedFilesManifests(undefined, undefined),
    undefined,
  );
  assert.deepEqual(
    owner.__rinOwnerMergeManagedFilesManifests(
      { trees: { prior: ["a"] } },
      undefined,
    ),
    { trees: { prior: ["a"] } },
  );
  assert.deepEqual(
    owner.__rinOwnerMergeManagedFilesManifests(undefined, {
      trees: { next: ["b"] },
    }),
    { trees: { next: ["b"] } },
  );
  assert.deepEqual(
    owner.__rinOwnerMergeManagedFilesManifests(
      { trees: { prior: ["a"] } },
      { trees: { next: ["b"] } },
    ),
    { trees: { prior: ["a"], next: ["b"] } },
  );
});

function createFsDeps(home: string) {
  const privilegedWrites: Array<{
    filePath: string;
    ownerUser?: string;
    ownerGroup?: string | number;
  }> = [];
  const privilegedCommands: Array<[string, string[]]> = [];
  const launcherWrites: Array<{
    userName: string;
    installDir: string;
    elevated: boolean;
  }> = [];
  const deps = {
    findSystemUser(targetUser: string) {
      return { name: targetUser, gid: 1200, home };
    },
    ensureDir(dir: string) {
      fs.mkdirSync(dir, { recursive: true });
    },
    readInstallerJson<T>(filePath: string, fallback: T) {
      try {
        return readJson<T>(filePath);
      } catch {
        return fallback;
      }
    },
    writeJsonFileWithPrivilege(
      filePath: string,
      value: unknown,
      ownerUser?: string,
      ownerGroup?: string | number,
    ) {
      privilegedWrites.push({ filePath, ownerUser, ownerGroup });
      writeJson(filePath, value);
    },
    writeJsonFile(filePath: string, value: unknown) {
      writeJson(filePath, value);
    },
    runPrivileged(command: string, args: string[]) {
      privilegedCommands.push([command, args]);
      if (command === "rm" && args[0] === "-f") {
        fs.rmSync(args[1], { force: true });
      }
    },
    launcherMetadataPathForUser(userName: string) {
      return path.join(home, ".config", "rin", `${userName}-launcher.json`);
    },
    readJsonFile<T>(filePath: string, fallback: T) {
      try {
        return readJson<T>(filePath);
      } catch {
        return fallback;
      }
    },
    writeLaunchersForUser(
      userName: string,
      installDir: string,
      options: { elevated?: boolean } = {},
    ) {
      launcherWrites.push({
        userName,
        installDir,
        elevated: Boolean(options.elevated),
      });
      return {
        rinPath: path.join(home, ".local", "bin", `${userName}-rin`),
        rinInstallPath: path.join(
          home,
          ".local",
          "bin",
          `${userName}-rin-install`,
        ),
      };
    },
    reconcileInstallerManifest,
  };
  return { deps, privilegedWrites, privilegedCommands, launcherWrites };
}

test("installer manifest reconciliation preserves recovery metadata and normalizes releases", async () => {
  await withInstallRoot(async (root) => {
    const installDir = path.join(root, "install");
    const home = path.join(root, "home");
    const { deps, privilegedCommands } = createFsDeps(home);
    const paths = installerManifestPaths(installDir, home);
    writeJson(paths.manifestPath, {
      currentRelease: {
        name: "release-old",
        path: "/releases/old",
        release: {
          channel: "git",
          version: "fa6440641234567890",
          branch: "owner-branch",
          ref: "fa6440641234567890",
        },
      },
      previousRelease: { name: "release-older", path: "/releases/older" },
      service: { kind: "systemd", label: "rin-owner.service" },
      managedFiles: {
        trees: { docs: ["b.md", "a.md", "a.md", "/invalid", "."] },
      },
    });
    const legacyManaged = path.join(
      installDir,
      "data",
      ".managed",
      "install-home.json",
    );
    writeJson(legacyManaged, { trees: { skills: ["owner/SKILL.md"] } });

    const result = reconcileInstallerManifest(
      {
        targetUser: "owner",
        installDir,
        release: {
          channel: "unexpected" as any,
          version: "1.2.3",
          branch: "",
          ref: "",
          sourceLabel: "",
          archiveUrl: "",
        },
        currentReleaseName: "release-current",
        currentReleaseRoot: "/releases/current",
        previousReleaseName: "release-old",
        previousReleaseRoot: "/releases/old",
        managedFiles: {
          trees: { docs: ["c.md", "c.md", "nested\\d.md"] },
        },
      },
      deps,
    );
    assert.equal(result.manifestPath, paths.manifestPath);
    assert.equal(result.locatorManifestPath, paths.locatorManifestPath);
    const manifest = readJson<any>(paths.manifestPath);
    assert.equal(manifest.currentRelease.release.channel, "stable");
    assert.equal(manifest.currentRelease.release.branch, "stable");
    assert.equal(manifest.currentRelease.release.ref, "1.2.3");
    assert.equal(manifest.previousRelease.release.channel, "git");
    assert.equal(manifest.previousRelease.release.version, "fa6440641234");
    assert.equal(manifest.service.label, "rin-owner.service");
    assert.deepEqual(manifest.managedFiles.trees.docs, ["c.md", "nested/d.md"]);
    assert.equal(fs.existsSync(legacyManaged), false);
    assert.deepEqual(readJson(paths.locatorManifestPath), manifest);
    assert.deepEqual(privilegedCommands, []);

    reconcileInstallerManifest(
      {
        targetUser: "owner",
        installDir,
        currentReleaseName: "release-current",
        previousReleaseName: "release-current",
        service: {
          kind: "launchd",
          label: "com.owner.rin",
          path: "/Library/LaunchAgents/com.owner.rin.plist",
        },
      },
      deps,
    );
    const sameRelease = readJson<any>(paths.manifestPath);
    assert.equal(sameRelease.previousRelease?.name, "release-old");
    assert.equal(sameRelease.service.kind, "launchd");
  });
});

test("installer manifest release normalization handles git and prerelease metadata boundaries", async () => {
  await withInstallRoot(async (root) => {
    const installDir = path.join(root, "install");
    const home = path.join(root, "home");
    const { deps } = createFsDeps(home);
    const manifestPath = installerManifestPaths(installDir, home).manifestPath;

    reconcileInstallerManifest(
      {
        targetUser: "owner",
        installDir,
        release: {
          channel: "git",
          version: "abcdef1234567890",
          branch: "",
          ref: "abcdef1234567890",
          sourceLabel: "",
          archiveUrl: "https://example.test/source.tar.gz",
        },
        currentReleaseName: "git-concrete",
      },
      deps,
    );
    let manifest = readJson<any>(manifestPath);
    assert.deepEqual(manifest.currentRelease.release, {
      channel: "git",
      version: "abcdef123456",
      branch: "main",
      ref: "abcdef1234567890",
      sourceLabel: "git main",
      archiveUrl: "https://example.test/source.tar.gz",
    });

    reconcileInstallerManifest(
      {
        targetUser: "owner",
        installDir,
        release: {
          channel: "git",
          version: "abcdef1234567890",
          branch: "feature",
          ref: "symbolic-ref",
          sourceLabel: "",
          archiveUrl: "",
        },
        currentReleaseName: "git-version-hash",
        previousReleaseName: "git-concrete",
      },
      deps,
    );
    manifest = readJson<any>(manifestPath);
    assert.equal(manifest.currentRelease.release.version, "abcdef123456");
    assert.equal(manifest.currentRelease.release.ref, "abcdef1234567890");
    assert.equal(manifest.currentRelease.release.sourceLabel, "git feature");
    assert.equal(manifest.previousRelease.name, "git-concrete");

    reconcileInstallerManifest(
      {
        targetUser: "owner",
        installDir,
        release: {
          channel: "beta",
          version: "",
          branch: "preview",
          ref: "",
          sourceLabel: "",
          archiveUrl: "",
        },
        currentReleaseName: "beta-preview",
        currentReleaseRoot: "",
        previousReleaseName: "missing-release",
      },
      deps,
    );
    manifest = readJson<any>(manifestPath);
    assert.equal(manifest.currentRelease.release.version, "unknown");
    assert.equal(manifest.currentRelease.release.branch, "preview");
    assert.equal(manifest.currentRelease.release.ref, "main");
    assert.equal(manifest.currentRelease.release.sourceLabel, "beta unknown");
    assert.equal(Object.hasOwn(manifest.currentRelease, "path"), false);

    reconcileInstallerManifest(
      {
        targetUser: "owner",
        installDir,
        release: {
          channel: "stable",
          version: "",
          branch: "",
          ref: "",
          sourceLabel: "",
          archiveUrl: "",
        },
        currentReleaseName: "metadata-empty",
        managedFiles: { trees: { invalid: [] } },
      },
      deps,
    );
    manifest = readJson<any>(manifestPath);
    assert.equal(manifest.currentRelease.release, undefined);
    assert.equal(manifest.managedFiles, undefined);
  });
});

test("installer outputs persist settings, auth, initialization, launchers, and cross-user targets", async () => {
  await withInstallRoot(async (root) => {
    const installDir = path.join(root, "install");
    const home = path.join(root, "home");
    const { deps, launcherWrites } = createFsDeps(home);
    writeJson(installSettingsPath(installDir), {
      koishi: { removed: true },
      extensions: ["owner-extension"],
      chat: { quietMode: { default: true } },
    });
    writeJson(installAuthPath(installDir), { existing: "kept" });

    const withoutLaunchers = await persistInstallerOutputs(
      {
        currentUser: "alice",
        targetUser: "bob",
        installDir,
        provider: "owner-provider",
        modelId: "owner-model",
        thinkingLevel: "high",
        language: "zh-cn",
        authData: { token: "owner-token" },
        currentReleaseName: "release-current",
        writeLaunchers: false,
        initializationComplete: false,
      },
      deps,
    );
    assert.equal(Object.hasOwn(withoutLaunchers, "launcherPath"), false);
    const settings = readJson<any>(withoutLaunchers.settingsPath);
    assert.deepEqual(settings.koishi, { removed: true });
    assert.deepEqual(settings.chat, { quietMode: { default: true } });
    assert.equal(settings.defaultProvider, "owner-provider");
    assert.equal(settings.defaultModel, "owner-model");
    assert.equal(settings.defaultThinkingLevel, "high");
    assert.equal(Object.hasOwn(settings, "language"), false);
    assert.deepEqual(settings.extensions, ["owner-extension"]);
    assert.deepEqual(readJson(withoutLaunchers.authPath), {
      existing: "kept",
      token: "owner-token",
    });
    const initState = readJson<any>(withoutLaunchers.initStatePath);
    assert.equal(initState.initialized, false);
    assert.equal(initState.lastTrigger, "install_fresh");

    const withLaunchers = await persistInstallerOutputs(
      {
        currentUser: "alice",
        targetUser: "bob",
        installDir,
        provider: "",
        modelId: "",
        thinkingLevel: "",
        authData: null,
        currentReleaseName: "release-current",
        setDefaultTarget: false,
        initializationComplete: true,
      },
      deps,
    );
    const launcher = readJson<any>(withLaunchers.launcherPath);
    assert.equal(launcher.defaultTargetUser, undefined);
    assert.equal(launcher.defaultInstallDir, undefined);
    assert.equal(launcher.installedBy, "alice");
    assert.equal(withLaunchers.currentRinPath?.endsWith("alice-rin"), true);
    assert.equal(withLaunchers.targetRinPath?.endsWith("bob-rin"), true);
    assert.deepEqual(launcherWrites, [
      { userName: "alice", installDir, elevated: false },
      { userName: "bob", installDir, elevated: false },
    ]);

    writeJson(installSettingsPath(installDir), {
      extensions: ["same-user-extension"],
    });
    const sameUser = await persistInstallerOutputs(
      {
        currentUser: "alice",
        targetUser: "alice",
        installDir,
        provider: "owner-provider",
        modelId: "owner-model",
        thinkingLevel: "medium",
        authData: {},
        currentReleaseName: "release-current",
      },
      deps,
    );
    assert.equal(
      readJson<any>(sameUser.launcherPath).defaultTargetUser,
      "alice",
    );
    assert.deepEqual(readJson<any>(sameUser.settingsPath).extensions, [
      "same-user-extension",
    ]);
    assert.equal(sameUser.currentRinPath, sameUser.targetRinPath);
    assert.deepEqual(launcherWrites.at(-1), {
      userName: "alice",
      installDir,
      elevated: false,
    });

    const fallbackInstallDir = path.join(root, "fallback-install");
    const fallback = await persistInstallerOutputs(
      {
        currentUser: "fallback",
        targetUser: "fallback",
        installDir: fallbackInstallDir,
        provider: "",
        modelId: "",
        thinkingLevel: "",
        authData: null,
        currentReleaseName: "release-current",
        writeLaunchers: false,
        initializationComplete: false,
      },
      {
        ...deps,
        findSystemUser: () => null,
        reconcileInstallerManifest: () => ({
          manifestPath: path.join(root, "fallback-manifest.json"),
          locatorManifestPath: path.join(root, "fallback-locator.json"),
        }),
      },
    );
    assert.equal(fallback.launcherPath, undefined);
    assert.equal(readJson<any>(fallback.initStatePath).initialized, false);
  });
});

test("install migration phases delegate memory ownership to the target user", async () => {
  await withInstallRoot(async (installDir) => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const options = {
      targetUser: "owner",
      installDir,
      elevated: true,
      migrationRuntimeRoot: "/runtime",
      targetNodePath: "/runtime/node",
    };
    const deps = {
      runPrivileged() {},
      runCommandAsUser(_user: string, command: string, args: string[]) {
        commands.push({ command, args });
      },
      captureCommandAsUser() {
        return "0";
      },
    };
    assert.deepEqual(
      preflightInstallUpgradeMigrations(options, deps).map((item) => item.id),
      ["transcript-search-schema-v6-preflight"],
    );
    const applied = applyInstallUpgradeMigrations(
      { ...options, runtimeQuiesced: true },
      deps,
    );
    assert.equal(
      applied.some((item) => item.id === "transcript-search-schema-v6"),
      true,
    );
    assert.equal(
      commands.some((entry) => entry.args.join(" ").includes("chat")),
      false,
    );
    assert.equal(
      commands.some((entry) => entry.args.includes("--runtime-quiesced")),
      true,
    );
    assert.equal(
      finalizeInstallUpgradeMigrations(options, deps)?.skipped,
      false,
    );
    assert.equal(
      rollbackInstallUpgradeMigrations(options, deps)?.skipped,
      false,
    );
  });
});

test("elevated migrations reject owned data moves without target-user command support", async () => {
  await withInstallRoot(async (installDir) => {
    fs.mkdirSync(path.join(installDir, "data", "browse"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(installDir, "data", "browse", "owner.txt"),
      "owner",
    );
    assert.throws(
      () =>
        applyInstallUpgradeMigrations(
          { targetUser: "owner", installDir, elevated: true },
          { runPrivileged() {} },
        ),
      /target-user command support/,
    );
  });
});

test("elevated installer writes use target ownership without interpreting settings", async () => {
  await withInstallRoot(async (root) => {
    const installDir = path.join(root, "install");
    const home = path.join(root, "home");
    const { deps, privilegedWrites } = createFsDeps(home);
    (deps as any).findSystemUser = () => ({ name: "", home: "", gid: 1200 });
    writeJson(installSettingsPath(installDir), {
      koishi: { removed: true },
      chat: { quietMode: "quiet" },
    });

    const normalized = normalizeInstalledSettings(
      { targetUser: "owner", installDir, elevated: true },
      deps,
    );
    assert.equal(normalized.settingsPath, installSettingsPath(installDir));
    assert.deepEqual(readJson<any>(normalized.settingsPath), {
      koishi: { removed: true },
      chat: { quietMode: "quiet" },
    });
    assert.equal(privilegedWrites.length, 1);
    assert.deepEqual(privilegedWrites[0], {
      filePath: installSettingsPath(installDir),
      ownerUser: "owner",
      ownerGroup: 1200,
    });
  });
});
