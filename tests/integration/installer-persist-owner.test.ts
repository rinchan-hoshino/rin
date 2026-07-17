import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyInstallUpgradeMigrations,
  normalizeInstalledChatSettings,
  persistInstallerOutputs,
  reconcileInstallerManifest,
} from "../../dist/core/rin-install/persist.js";
import {
  installAuthPath,
  installerManifestPaths,
  installSettingsPath,
} from "../../dist/core/rin-install/paths.js";

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

test("install upgrade migrations move owned data and rewrite persisted chat history", async () => {
  await withInstallRoot(async (root) => {
    const installDir = path.join(root, "install");
    const dataDir = path.join(installDir, "data");
    fs.mkdirSync(path.join(dataDir, "chat-inbox"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "chat-inbox", "inbox.json"), "owner");
    fs.mkdirSync(path.join(dataDir, "chat-outbox"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "chat", "outbox"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "chat-outbox", "kept.txt"), "legacy");
    fs.mkdirSync(path.join(dataDir, "browse"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "sidecars", "browse"), {
      recursive: true,
    });

    const statePath = path.join(
      dataDir,
      "chats",
      "telegram",
      "owner-bot",
      "owner-chat",
      "state.json",
    );
    writeJson(statePath, {
      chatKey: "telegram:owner-chat:owner-bot",
      piSessionFile: "owner.jsonl",
    });
    const sessionPath = path.join(installDir, "sessions", "owner.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, '{"type":"session"}\n');
    const managedCollision = path.join(
      installDir,
      "sessions",
      "managed",
      "chat",
      "owner.jsonl",
    );
    fs.mkdirSync(path.dirname(managedCollision), { recursive: true });
    fs.writeFileSync(managedCollision, "existing\n");

    writeJson(path.join(installDir, "i18n.json"), {
      chatRuntime: {
        telegramWorking: {
          workingInitial: "Thinking",
          workingSuffix: "Still working",
        },
      },
      preserved: true,
    });
    const deliveredPath = path.join(
      dataDir,
      "chat",
      "outbox",
      "history",
      "delivered",
      "2026",
      "owner.json",
    );
    writeJson(deliveredPath, {
      payload: { deliveryKind: "final" },
      deliveryResult: ["message-owner", "message-owner"],
    });
    writeJson(path.join(path.dirname(deliveredPath), "without-kind.json"), {
      deliveryResult: ["ignored-message"],
    });
    const messagePath = path.join(
      dataDir,
      "chat",
      "message-store",
      "records",
      "owner.json",
    );
    writeJson(messagePath, {
      role: "assistant",
      messageId: "message-owner",
      text: "owner reply",
    });
    writeJson(
      path.join(dataDir, "chat", "message-store", "records", "already.json"),
      {
        role: "assistant",
        messageId: "already",
        deliveryKind: "interim",
      },
    );
    writeJson(
      path.join(dataDir, "chat", "message-store", "records", "user.json"),
      { role: "user", messageId: "message-owner" },
    );
    writeJson(
      path.join(dataDir, "chat", "message-store", "records", "unmapped.json"),
      { role: "assistant", messageId: "unmapped" },
    );

    const migrations = applyInstallUpgradeMigrations(
      { targetUser: "owner", installDir },
      { runPrivileged() {} },
    );
    const dataLayout = migrations.find((item) => item.id === "data-layout-v1");
    assert.ok(dataLayout);
    assert.equal(dataLayout?.moved >= 2, true);
    assert.equal(dataLayout?.skippedExistingTarget >= 1, true);
    assert.equal(
      fs.existsSync(path.join(dataDir, "chat", "inbox", "inbox.json")),
      true,
    );
    assert.equal(fs.existsSync(path.join(dataDir, "browse")), false);
    assert.equal(
      fs.existsSync(path.join(dataDir, "sidecars", "browse")),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(dataDir, "chat-outbox", "kept.txt")),
      true,
    );

    const migratedStatePath = path.join(
      dataDir,
      "chat",
      "session-state",
      "telegram",
      "owner-bot",
      "owner-chat",
      "state.json",
    );
    const state = readJson<any>(migratedStatePath);
    assert.equal(Object.hasOwn(state, "piSessionFile"), false);
    assert.equal(state.sessionFile, "managed/chat/owner-2.jsonl");
    assert.equal(
      fs.existsSync(
        path.join(installDir, "sessions", "managed", "chat", "owner-2.jsonl"),
      ),
      true,
    );
    assert.equal(readJson<any>(messagePath).deliveryKind, "final");
    const i18n = readJson<any>(path.join(installDir, "i18n.json"));
    assert.equal(i18n.chatRuntime, undefined);
    assert.deepEqual(i18n.chat.runtime.working.frames, [
      "Thinking",
      "Still working",
      "Still working.",
      "Still working..",
    ]);

    const repeated = applyInstallUpgradeMigrations(
      { targetUser: "owner", installDir },
      { runPrivileged() {} },
    );
    const stateRewrite = repeated.find(
      (item) => item.id === "chat-state-session-file-v1",
    );
    const managedRewrite = repeated.find(
      (item) => item.id === "chat-session-managed-file-v1",
    );
    assert.equal((stateRewrite as any)?.alreadyApplied, true);
    assert.equal((managedRewrite as any)?.alreadyApplied, true);
  });
});

test("install migrations preserve explicit working frames and skip ineligible chat state", async () => {
  await withInstallRoot(async (installDir) => {
    writeJson(path.join(installDir, "i18n.json"), {
      chat: { runtime: { working: { frames: ["One", "One", "Two"] } } },
      chatRuntime: { working: { frames: ["Legacy"] } },
    });
    const stateRoot = path.join(
      installDir,
      "data",
      "chat",
      "session-state",
      "onebot",
      "owner-bot",
    );
    writeJson(path.join(stateRoot, "missing", "state.json"), {
      sessionFile: "missing.jsonl",
    });
    writeJson(path.join(stateRoot, "managed", "state.json"), {
      sessionFile: "managed/chat/existing.jsonl",
    });
    writeJson(path.join(stateRoot, "outside", "state.json"), {
      sessionFile: "../outside.jsonl",
    });
    writeJson(path.join(stateRoot, "wrong-extension", "state.json"), {
      sessionFile: "owner.txt",
    });
    const absoluteSession = path.join(installDir, "sessions", "absolute.jsonl");
    fs.mkdirSync(path.dirname(absoluteSession), { recursive: true });
    fs.writeFileSync(absoluteSession, "absolute\n");
    writeJson(path.join(stateRoot, "absolute", "state.json"), {
      sessionFile: absoluteSession,
    });
    writeJson(path.join(stateRoot, "no-legacy-key", "state.json"), {
      current: true,
    });

    const migrations = applyInstallUpgradeMigrations(
      { targetUser: "owner", installDir },
      { runPrivileged() {} },
    );
    assert.deepEqual(
      readJson<any>(path.join(installDir, "i18n.json")).chat.runtime.working
        .frames,
      ["One", "Two"],
    );
    const managed = migrations.find(
      (item) => item.id === "chat-session-managed-file-v1",
    ) as any;
    assert.equal(managed.scanned, 6);
    assert.equal(managed.migrated, 1);
    assert.equal(managed.skipped, false);
    assert.equal(
      fs.existsSync(
        path.join(installDir, "sessions", "managed", "chat", "absolute.jsonl"),
      ),
      true,
    );
  });
});

test("elevated install migrations execute file ownership changes as the target user", async () => {
  await withInstallRoot(async (root) => {
    const installDir = path.join(root, "install");
    fs.mkdirSync(path.join(installDir, "data", "chat-inbox"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(installDir, "data", "chat-inbox", "owner.txt"),
      "owner",
    );
    fs.mkdirSync(path.join(installDir, "data", "browse"), {
      recursive: true,
    });
    writeJson(path.join(installDir, "i18n.json"), {
      chatRuntime: { working: { frames: ["Legacy one", "Legacy two"] } },
    });

    const commands: Array<[string, string[]]> = [];
    const runCommandAsUser = (
      targetUser: string,
      command: string,
      args: string[],
    ) => {
      assert.equal(targetUser, "owner");
      commands.push([command, [...args]]);
      if (command === "mkdir") {
        fs.mkdirSync(args.at(-1)!, { recursive: true });
      } else if (command === "mv") {
        fs.renameSync(args[0], args[1]);
      } else if (command === "rm") {
        fs.rmSync(args.at(-1)!, { recursive: true, force: true });
      } else if (command === "install") {
        fs.mkdirSync(path.dirname(args[3]), { recursive: true });
        fs.copyFileSync(args[2], args[3]);
        fs.chmodSync(args[3], Number.parseInt(args[1], 8));
      } else if (command === "test") {
        if (!fs.existsSync(args.at(-1)!)) throw new Error("missing");
      } else {
        throw new Error(`unexpected target-user command:${command}`);
      }
    };
    const migrations = applyInstallUpgradeMigrations(
      { targetUser: "owner", installDir, elevated: true },
      { runPrivileged() {}, runCommandAsUser },
    );
    assert.equal(
      fs.existsSync(
        path.join(installDir, "data", "chat", "inbox", "owner.txt"),
      ),
      true,
    );
    assert.equal(fs.existsSync(path.join(installDir, "data", "browse")), false);
    assert.deepEqual(
      readJson<any>(path.join(installDir, "i18n.json")).chat.runtime.working
        .frames,
      ["Legacy one", "Legacy two"],
    );
    assert.equal(
      migrations.some((item) => item.id === "chat-working-frames-i18n-v1"),
      true,
    );
    assert.equal(
      commands.some(([command]) => command === "mv"),
      true,
    );
    assert.equal(
      commands.some(([command]) => command === "rm"),
      true,
    );
    assert.equal(
      commands.some(([command]) => command === "install"),
      true,
    );
  });
});

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
          version: "",
          branch: "",
          ref: "",
          sourceLabel: "",
          archiveUrl: "https://example.test/source.tar.gz",
        },
        currentReleaseName: "git-unknown",
      },
      deps,
    );
    let manifest = readJson<any>(manifestPath);
    assert.deepEqual(manifest.currentRelease.release, {
      channel: "git",
      version: "unknown",
      branch: "main",
      ref: "",
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
        previousReleaseName: "git-unknown",
      },
      deps,
    );
    manifest = readJson<any>(manifestPath);
    assert.equal(manifest.currentRelease.release.version, "abcdef123456");
    assert.equal(manifest.currentRelease.release.ref, "abcdef1234567890");
    assert.equal(manifest.currentRelease.release.sourceLabel, "git feature");
    assert.equal(manifest.previousRelease.name, "git-unknown");

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
      extensions: ["rin:browse", "owner-extension"],
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
    assert.equal(settings.koishi, undefined);
    assert.equal(settings.defaultProvider, "owner-provider");
    assert.equal(settings.defaultModel, "owner-model");
    assert.equal(settings.defaultThinkingLevel, "high");
    assert.equal(settings.language, "zh_CN");
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
      extensions: ["rin:browse"],
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
    assert.equal(readJson<any>(sameUser.settingsPath).extensions, undefined);
    assert.equal(sameUser.currentRinPath, sameUser.targetRinPath);
    assert.deepEqual(launcherWrites.at(-1), {
      userName: "alice",
      installDir,
      elevated: false,
    });
  });
});

test("elevated migrations reject writes without target-user command ownership", async () => {
  await withInstallRoot(async (installDir) => {
    writeJson(path.join(installDir, "i18n.json"), {
      chatRuntime: { working: { frames: ["Owner"] } },
    });
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

test("working-frame migration handles legacy thinking keys and no-op locale files", async () => {
  await withInstallRoot(async (root) => {
    const legacyDir = path.join(root, "legacy");
    writeJson(path.join(legacyDir, "i18n.json"), {
      chatRuntime: {
        telegramWorking: {
          thinkingInitial: "Legacy thinking",
          thinkingSuffix: "",
        },
      },
    });
    const migrated = applyInstallUpgradeMigrations(
      { targetUser: "owner", installDir: legacyDir },
      { runPrivileged() {} },
    );
    assert.deepEqual(
      readJson<any>(path.join(legacyDir, "i18n.json")).chat.runtime.working
        .frames,
      ["Legacy thinking"],
    );
    assert.equal(
      migrated.some((item) => item.id === "chat-working-frames-i18n-v1"),
      true,
    );

    const noOpDir = path.join(root, "no-op");
    writeJson(path.join(noOpDir, "i18n.json"), {
      chatRuntime: { telegramWorking: {} },
      preserved: true,
    });
    const noOp = applyInstallUpgradeMigrations(
      { targetUser: "owner", installDir: noOpDir },
      { runPrivileged() {} },
    );
    assert.equal(
      noOp.some((item) => item.id === "chat-working-frames-i18n-v1"),
      false,
    );
    assert.equal(
      readJson<any>(path.join(noOpDir, "i18n.json")).preserved,
      true,
    );
  });
});

test("elevated installer writes use target ownership and normalize chat settings", async () => {
  await withInstallRoot(async (root) => {
    const installDir = path.join(root, "install");
    const home = path.join(root, "home");
    const { deps, privilegedWrites } = createFsDeps(home);
    (deps as any).findSystemUser = () => ({ home, gid: 1200 });
    writeJson(installSettingsPath(installDir), {
      koishi: { removed: true },
      chat: { quietMode: "quiet" },
    });

    const normalized = normalizeInstalledChatSettings(
      { targetUser: "owner", installDir, elevated: true },
      deps,
    );
    assert.equal(normalized.settingsPath, installSettingsPath(installDir));
    assert.equal(readJson<any>(normalized.settingsPath).koishi, undefined);
    assert.equal(privilegedWrites.length, 1);
    assert.deepEqual(privilegedWrites[0], {
      filePath: installSettingsPath(installDir),
      ownerUser: "owner",
      ownerGroup: 1200,
    });
  });
});
