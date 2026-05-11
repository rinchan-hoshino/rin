import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const provider = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "provider-auth.js"),
  ).href
);
const persist = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "persist.js"))
    .href
);
const installRecord = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "install-record.js"),
  ).href
);
const updater = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "updater.js"))
    .href
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-installer-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("updater renders install-style note boxes", () => {
  const rendered = updater.renderUpdaterNote(
    [
      "Current user: demo",
      "Selected daemon user: demo",
      "Install dir: /home/demo/.rin",
    ].join("\n"),
    "Update plan",
  );

  assert.match(rendered, /◇ {2}Update plan/);
  assert.match(rendered, /│ {2}Current user: demo/);
  assert.match(rendered, /│ {2}Selected daemon user: demo/);
  assert.match(rendered, /├─+╯/);
});

test("provider-auth computes available thinking levels deterministically", () => {
  assert.deepEqual(
    provider.computeAvailableThinkingLevels({
      provider: "openai",
      id: "codex-max",
      reasoning: true,
    }),
    ["off", "minimal", "low", "medium", "high", "xhigh"],
  );
  assert.deepEqual(
    provider.computeAvailableThinkingLevels({
      provider: " anthropic ",
      id: " claude ",
      reasoning: true,
    }),
    ["off", "minimal", "low", "medium", "high"],
  );
  assert.deepEqual(
    provider.computeAvailableThinkingLevels({
      provider: "x",
      id: "y",
      reasoning: false,
    }),
    ["off"],
  );

  assert.deepEqual(
    provider.computeAvailableThinkingLevels({
      provider: "deepseek",
      id: "deepseek-reasoner",
      reasoning: true,
      thinkingLevelMap: { off: null, xhigh: "max" },
    }),
    ["minimal", "low", "medium", "high", "xhigh"],
  );

  const first = provider.computeAvailableThinkingLevels({
    provider: "openai",
    id: "codex-max",
    reasoning: true,
  });
  first.pop();
  assert.deepEqual(
    provider.computeAvailableThinkingLevels({
      provider: "openai",
      id: "codex-max",
      reasoning: true,
    }),
    ["off", "minimal", "low", "medium", "high", "xhigh"],
  );
});

test("provider-auth loads installer model choices through the shared model registry", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, "auth.json"),
      `${JSON.stringify({ openai: { type: "api_key", key: "test-key" } })}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(dir, "models.json"),
      `${JSON.stringify({
        providers: {
          "local-test": {
            baseUrl: "http://127.0.0.1:11434/v1",
            apiKey: "literal:test-key",
            api: "openai",
            models: [{ id: "llama-test", reasoning: true }],
          },
        },
      })}\n`,
      "utf8",
    );

    const choices = await provider.loadModelChoices(
      dir,
      (filePath, fallback) => {
        try {
          return JSON.parse(String(fsSync.readFileSync(filePath, "utf8")));
        } catch {
          return fallback;
        }
      },
    );

    assert.ok(
      choices.some(
        (model) => model.provider === "openai" && model.available === true,
      ),
    );
    assert.ok(
      choices.some(
        (model) =>
          model.provider === "local-test" &&
          model.id === "llama-test" &&
          model.reasoning === true &&
          model.available === true,
      ),
    );
  });
});

test("install-record normalizes launcher metadata and installer manifests", () => {
  assert.deepEqual(
    installRecord.normalizeInstallRecord("/home/demo", {
      defaultTargetUser: "launcher-demo",
      defaultInstallDir: "/srv/rin-demo",
    }),
    {
      defaultTargetUser: "launcher-demo",
      defaultInstallDir: "/srv/rin-demo",
    },
  );
  assert.deepEqual(
    installRecord.normalizeInstallRecord("/home/demo", {
      targetUser: "manifest-demo",
    }),
    {
      defaultTargetUser: "manifest-demo",
      defaultInstallDir: "/home/demo/.rin",
    },
  );
  assert.deepEqual(
    installRecord.normalizeInstallRecord("/home/demo", {
      defaultTargetUser: "launcher-demo",
      installDir: "/srv/rin-demo",
    }),
    {
      defaultTargetUser: "launcher-demo",
      defaultInstallDir: "/srv/rin-demo",
    },
  );
  assert.deepEqual(
    installRecord.normalizeInstallRecord("/home/demo", {
      targetUser: "manifest-demo",
      defaultInstallDir: "/srv/rin-demo",
    }),
    {
      defaultTargetUser: "manifest-demo",
      defaultInstallDir: "/srv/rin-demo",
    },
  );
  assert.deepEqual(
    installRecord.normalizeInstallRecord("/home/demo", {
      defaultTargetUser: "   ",
      targetUser: " manifest-demo ",
      defaultInstallDir: "   ",
      installDir: " /srv/rin-demo ",
    }),
    {
      defaultTargetUser: "manifest-demo",
      defaultInstallDir: "/srv/rin-demo",
    },
  );
  assert.deepEqual(
    installRecord.normalizeInstallRecord("/home/demo", {
      defaultTargetUser: "launcher-demo",
    }),
    {
      defaultTargetUser: "launcher-demo",
      defaultInstallDir: "/home/demo/.rin",
    },
  );
  assert.equal(
    installRecord.normalizeInstallRecord("/home/demo", {
      defaultTargetUser: "   ",
      targetUser: "",
      defaultInstallDir: "   ",
      installDir: "",
    }),
    null,
  );
  assert.deepEqual(
    installRecord.resolveInstallRecordTarget("/home/demo", "fallback-user", {
      defaultInstallDir: "/srv/rin-demo",
    }),
    {
      targetUser: "fallback-user",
      installDir: "/srv/rin-demo",
    },
  );
  assert.deepEqual(
    installRecord.resolveInstallRecordTarget("/home/demo", " fallback-user ", {
      defaultInstallDir: " /srv/rin-demo ",
    }),
    {
      targetUser: "fallback-user",
      installDir: "/srv/rin-demo",
    },
  );

  const readCalls = [];
  assert.deepEqual(
    installRecord.loadInstallRecordFromCandidates(
      "/home/demo",
      ["broken", "empty", "manifest", "unused"],
      (filePath) => {
        readCalls.push(filePath);
        if (filePath === "broken") throw new Error("broken json");
        if (filePath === "empty") return [];
        if (filePath === "manifest") return { targetUser: "candidate-demo" };
        return { targetUser: "unused-demo" };
      },
    ),
    {
      defaultTargetUser: "candidate-demo",
      defaultInstallDir: "/home/demo/.rin",
    },
  );
  assert.deepEqual(readCalls, ["broken", "empty", "manifest"]);

  assert.deepEqual(
    installRecord.loadInstallRecordFromCandidates(
      "/home/demo",
      ["mixed", "unused"],
      (filePath) =>
        filePath === "mixed"
          ? { defaultTargetUser: "launcher-demo", installDir: "/srv/rin-demo" }
          : { targetUser: "unused-demo" },
    ),
    {
      defaultTargetUser: "launcher-demo",
      defaultInstallDir: "/srv/rin-demo",
    },
  );

  assert.deepEqual(
    installRecord.resolveInstallRecordTargetFromCandidates(
      "/home/demo",
      "fallback-user",
      ["missing", "launcher"],
      (filePath) =>
        filePath === "launcher" ? { defaultInstallDir: "/srv/rin-demo" } : null,
    ),
    {
      targetUser: "fallback-user",
      installDir: "/srv/rin-demo",
    },
  );
  assert.equal(installRecord.normalizeInstallRecord("/home/demo", null), null);
});

test("persist reconcileInstallerManifest writes primary and locator manifests for custom install dirs", async () => {
  await withTempDir(async (dir) => {
    const installDir = path.join(dir, "srv", "rin-demo");
    const ownerHome = path.join(dir, "home", "demo");
    const writes = [];
    const result = persist.reconcileInstallerManifest(
      {
        targetUser: "demo",
        installDir,
        provider: "openai",
        modelId: "gpt",
        thinkingLevel: "medium",
        chatConfig: { telegram: { token: "x" } },
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000, home: ownerHome }),
        ensureDir: async () => {},
        readInstallerJson: (_filePath, fallback) =>
          fallback === null
            ? { koishi: { telegram: { token: "legacy" } } }
            : fallback,
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
        runPrivileged: () => {},
      },
    );
    assert.equal(result.manifestPath, path.join(installDir, "installer.json"));
    assert.equal(
      result.locatorManifestPath,
      path.join(ownerHome, ".rin", "installer.json"),
    );
    assert.equal(writes.length, 2);
    assert.deepEqual(
      writes.map((entry) => entry.filePath).sort(),
      [result.manifestPath, result.locatorManifestPath].sort(),
    );
    assert.equal(writes[0].value.defaultProvider, "openai");
    assert.equal(writes[0].value.defaultModel, "gpt");
    assert.equal(writes[0].value.defaultThinkingLevel, "medium");
    assert.equal("koishi" in writes[0].value, false);
  });
});

test("persist reconcileInstallerManifest persists release metadata when provided", async () => {
  await withTempDir(async (dir) => {
    const installDir = path.join(dir, "srv", "rin-demo");
    const ownerHome = path.join(dir, "home", "demo");
    const writes = [];

    persist.reconcileInstallerManifest(
      {
        targetUser: "demo",
        installDir,
        release: {
          channel: "beta",
          version: "1.3.0-beta.2",
          branch: "release/1.3",
          ref: "1.3.0-beta.2",
          sourceLabel: "beta version 1.3.0-beta.2",
          archiveUrl: "https://example.com/release-1.3-beta.2.tgz",
          installedAt: "2026-04-20T10:00:00.000Z",
        },
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000, home: ownerHome }),
        ensureDir: async () => {},
        readInstallerJson: (_filePath, fallback) => fallback,
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
        runPrivileged: () => {},
      },
    );

    assert.equal(writes.length, 2);
    for (const entry of writes) {
      assert.deepEqual(entry.value.release, {
        channel: "beta",
        version: "1.3.0-beta.2",
        branch: "release/1.3",
        ref: "1.3.0-beta.2",
        sourceLabel: "beta version 1.3.0-beta.2",
        archiveUrl: "https://example.com/release-1.3-beta.2.tgz",
        installedAt: "2026-04-20T10:00:00.000Z",
      });
    }
  });
});

test("persist reconcileInstallerManifest records current and previous release rollback metadata", async () => {
  await withTempDir(async (dir) => {
    const installDir = path.join(dir, "srv", "rin-demo");
    const ownerHome = path.join(dir, "home", "demo");
    const writes = [];

    const release = {
      channel: "stable" as const,
      version: "1.3.0",
      branch: "stable",
      ref: "1.3.0",
      sourceLabel: "stable version 1.3.0",
      archiveUrl: "https://example.com/release-1.3.0.tgz",
    };
    const options = {
      targetUser: "demo",
      installDir,
      release,
      currentReleaseName: "1.3.0",
      currentReleaseRoot: path.join(installDir, "app", "releases", "1.3.0"),
      previousReleaseName: "1.2.0",
      previousReleaseRoot: path.join(installDir, "app", "releases", "1.2.0"),
      elevated: false,
    };
    const deps = {
      findSystemUser: () => ({ name: "demo", gid: 1000, home: ownerHome }),
      ensureDir: async () => {},
      readInstallerJson: (_filePath, fallback) =>
        fallback === null
          ? writes.at(-1)?.value || {
              release: {
                channel: "stable",
                version: "1.2.0",
                branch: "stable",
                ref: "1.2.0",
                sourceLabel: "stable version 1.2.0",
                archiveUrl: "https://example.com/release-1.2.0.tgz",
              },
            }
          : fallback,
      writeJsonFileWithPrivilege: () => {},
      writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
      runPrivileged: () => {},
    };

    persist.reconcileInstallerManifest(options, deps);
    persist.reconcileInstallerManifest(options, deps);

    assert.equal(writes.length, 4);
    for (const entry of writes) {
      assert.equal(entry.value.currentRelease.name, "1.3.0");
      assert.equal(entry.value.currentRelease.release.version, "1.3.0");
      assert.equal(entry.value.previousRelease.name, "1.2.0");
      assert.equal(entry.value.previousRelease.release.version, "1.2.0");
    }
  });
});

test("persist reconcileInstallerManifest skips malformed recovery candidates before reusing a prior manifest", async () => {
  await withTempDir(async (dir) => {
    const installDir = path.join(dir, "srv", "rin-demo");
    const ownerHome = path.join(dir, "home", "demo");
    const writes = [];
    const readCalls = [];

    persist.reconcileInstallerManifest(
      {
        targetUser: "demo",
        installDir,
        provider: "openai",
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000, home: ownerHome }),
        ensureDir: async () => {},
        readInstallerJson: (filePath, fallback) => {
          readCalls.push(filePath);
          if (filePath === path.join(installDir, "installer.json")) return [];
          if (filePath === path.join(ownerHome, ".rin", "installer.json")) {
            return { preserved: true, defaultModel: "existing-model" };
          }
          return fallback;
        },
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
        runPrivileged: () => {},
      },
    );

    assert.deepEqual(readCalls, [
      path.join(installDir, "installer.json"),
      path.join(ownerHome, ".rin", "installer.json"),
    ]);
    assert.equal(writes.length, 2);
    for (const entry of writes) {
      assert.equal(entry.value.preserved, true);
      assert.equal(entry.value.defaultModel, "existing-model");
      assert.equal(entry.value.defaultProvider, "openai");
    }
  });
});

test("persist reconcileInstallerManifest avoids duplicate writes for default install dirs", async () => {
  await withTempDir(async (dir) => {
    const ownerHome = path.join(dir, "home", "demo");
    const installDir = path.join(ownerHome, ".rin");
    const writes = [];
    const result = persist.reconcileInstallerManifest(
      {
        targetUser: "demo",
        installDir,
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000, home: ownerHome }),
        ensureDir: async () => {},
        readInstallerJson: (_filePath, fallback) => fallback,
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
        runPrivileged: () => {},
      },
    );
    assert.equal(result.manifestPath, result.locatorManifestPath);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].filePath, path.join(installDir, "installer.json"));
  });
});

test("persist reconcileInstallerManifest stores configured language in installer manifest", async () => {
  await withTempDir(async (dir) => {
    const ownerHome = path.join(dir, "home", "demo");
    const installDir = path.join(ownerHome, ".rin");
    const writes = [];
    const result = persist.reconcileInstallerManifest(
      {
        targetUser: "demo",
        installDir,
        provider: "openai",
        modelId: "gpt",
        thinkingLevel: "medium",
        language: "zh-CN",
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000, home: ownerHome }),
        ensureDir: async () => {},
        readInstallerJson: (_filePath, fallback) => fallback,
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
        runPrivileged: () => {},
      },
    );

    assert.equal(result.manifestPath, result.locatorManifestPath);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].value.defaultProvider, "openai");
    assert.equal(writes[0].value.defaultModel, "gpt");
    assert.equal(writes[0].value.defaultThinkingLevel, "medium");
    assert.equal(writes[0].value.language, "zh-CN");
  });
});

test("persist reconcileInstallerManifest preserves existing chat config when new chat config is malformed", async () => {
  await withTempDir(async (dir) => {
    const installDir = path.join(dir, "srv", "rin-demo");
    const ownerHome = path.join(dir, "home", "demo");
    const writes = [];

    persist.reconcileInstallerManifest(
      {
        targetUser: "demo",
        installDir,
        provider: "openai",
        chatConfig: "broken",
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000, home: ownerHome }),
        ensureDir: async () => {},
        readInstallerJson: (_filePath, fallback) =>
          fallback === null
            ? { chat: { telegram: { token: "existing" } } }
            : fallback,
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
        runPrivileged: () => {},
      },
    );

    assert.equal(writes.length, 2);
    for (const entry of writes) {
      assert.deepEqual(entry.value.chat, { telegram: { token: "existing" } });
      assert.equal(entry.value.defaultProvider, "openai");
    }
  });
});

test("persistInstallerOutputs stores configured language in settings", async () => {
  await withTempDir(async (dir) => {
    const writes = [];
    const launchWrites = [];
    const result = await persist.persistInstallerOutputs(
      {
        currentUser: "alice",
        targetUser: "demo",
        installDir: dir,
        provider: "openai",
        modelId: "gpt",
        thinkingLevel: "medium",
        language: "zh-CN",
        chatConfig: {},
        authData: {},
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000 }),
        ensureDir: async () => {},
        readInstallerJson: (_filePath, fallback) => fallback,
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
        launcherMetadataPathForUser: () => path.join(dir, "launcher.json"),
        readJsonFile: (_filePath, fallback) => fallback,
        writeLaunchersForUser: () => {
          launchWrites.push(true);
          return {
            rinPath: path.join(dir, "rin"),
            rinInstallPath: path.join(dir, "rin-install"),
          };
        },
        reconcileInstallerManifest: persist.reconcileInstallerManifest,
        runPrivileged: () => {},
      },
    );

    assert.equal(
      result.settingsPath.endsWith(path.join(dir, "settings.json")),
      true,
    );
    assert.equal(launchWrites.length, 2);
    const settingsWrite = writes.find(
      (entry) => entry.filePath === result.settingsPath,
    );
    assert.ok(settingsWrite);
    assert.equal(settingsWrite.value.defaultProvider, "openai");
    assert.equal(settingsWrite.value.defaultModel, "gpt");
    assert.equal(settingsWrite.value.defaultThinkingLevel, "medium");
    assert.equal(settingsWrite.value.language, "zh-CN");
  });
});

test("persist normalizeInstalledChatSettings drops removed adapter settings without reusing them", async () => {
  await withTempDir(async (dir) => {
    const writes = [];
    persist.normalizeInstalledChatSettings(
      {
        targetUser: "demo",
        installDir: dir,
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000 }),
        readInstallerJson: () => ({
          koishi: { telegram: { token: "x" } },
          keep: true,
        }),
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
        runPrivileged: () => {},
      },
    );
    assert.equal(writes.length, 1);
    assert.ok(writes[0].filePath.endsWith(path.join(dir, "settings.json")));
    assert.deepEqual(writes[0].value, { keep: true });
  });
});

test("persist normalizeInstalledChatSettings applies install upgrade migrations", async () => {
  await withTempDir(async (dir) => {
    const previousStoreDir = path.join(dir, "data", "koishi-message-store");
    const currentStoreDir = path.join(dir, "data", "chat-message-store");
    await fs.mkdir(previousStoreDir, { recursive: true });
    await fs.writeFile(
      path.join(previousStoreDir, "marker.txt"),
      "old\n",
      "utf8",
    );

    const result = persist.normalizeInstalledChatSettings(
      {
        targetUser: "demo",
        installDir: dir,
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000 }),
        readInstallerJson: (_filePath, fallback) => fallback,
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: () => {},
        runPrivileged: () => {},
      },
    );

    await fs.access(path.join(currentStoreDir, "marker.txt"));
    await assert.rejects(fs.access(path.join(previousStoreDir, "marker.txt")));
    assert.deepEqual(result.migrations, [
      {
        id: "chat-message-store-dir",
        fromPath: previousStoreDir,
        toPath: currentStoreDir,
        moved: true,
        skipped: false,
      },
      {
        id: "chat-state-session-file-v1",
        markerPath: path.join(
          dir,
          "data",
          "migrations",
          "chat-state-session-file-v1.json",
        ),
        alreadyApplied: false,
        skipped: true,
        scanned: 0,
        migrated: 0,
        migratedFiles: [],
      },
      {
        id: "chat-session-managed-file-v1",
        markerPath: path.join(
          dir,
          "data",
          "migrations",
          "chat-session-managed-file-v1.json",
        ),
        alreadyApplied: false,
        skipped: true,
        scanned: 0,
        migrated: 0,
        migratedFiles: [],
      },
    ]);
    await assert.rejects(fs.access(result.migrations[1].markerPath));
    await assert.rejects(fs.access(result.migrations[2].markerPath));
  });
});

test("persist normalizeInstalledChatSettings migrates previous chat state session files", async () => {
  await withTempDir(async (dir) => {
    const chatStatePath = path.join(
      dir,
      "data",
      "chats",
      "telegram",
      "1",
      "2",
      "state.json",
    );
    const detachedStatePath = path.join(
      dir,
      "data",
      "cron-turns",
      "cron_demo",
      "state.json",
    );
    await fs.mkdir(path.dirname(chatStatePath), { recursive: true });
    await fs.mkdir(path.dirname(detachedStatePath), { recursive: true });
    await fs.writeFile(
      chatStatePath,
      JSON.stringify({ chatKey: "telegram/1:2", piSessionFile: "chat.jsonl" }),
    );
    await fs.writeFile(
      detachedStatePath,
      JSON.stringify({ chatKey: "cron:test", piSessionFile: "turn.jsonl" }),
    );

    const result = persist.normalizeInstalledChatSettings(
      {
        targetUser: "demo",
        installDir: dir,
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000 }),
        readInstallerJson: (_filePath, fallback) => fallback,
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: () => {},
        runPrivileged: () => {},
      },
    );

    assert.deepEqual(JSON.parse(await fs.readFile(chatStatePath, "utf8")), {
      chatKey: "telegram/1:2",
      sessionFile: "chat.jsonl",
    });
    assert.deepEqual(JSON.parse(await fs.readFile(detachedStatePath, "utf8")), {
      chatKey: "cron:test",
      sessionFile: "turn.jsonl",
    });
    assert.equal(result.migrations[1].id, "chat-state-session-file-v1");
    assert.equal(result.migrations[1].skipped, false);
    assert.equal(result.migrations[1].scanned, 2);
    assert.equal(result.migrations[1].migrated, 2);
    assert.equal(result.migrations[2].id, "chat-session-managed-file-v1");
    assert.equal(result.migrations[2].skipped, true);
    await fs.access(result.migrations[1].markerPath);
    await assert.rejects(fs.access(result.migrations[2].markerPath));
  });
});

test("persist normalizeInstalledChatSettings moves chat-bound root sessions under managed chat", async () => {
  await withTempDir(async (dir) => {
    const chatStatePath = path.join(
      dir,
      "data",
      "chats",
      "telegram",
      "1",
      "2",
      "state.json",
    );
    const managedStatePath = path.join(
      dir,
      "data",
      "chats",
      "telegram",
      "1",
      "3",
      "state.json",
    );
    const rootSessionPath = path.join(dir, "sessions", "chat-root.jsonl");
    const managedSessionPath = path.join(
      dir,
      "sessions",
      "managed",
      "chat",
      "already.jsonl",
    );
    await fs.mkdir(path.dirname(chatStatePath), { recursive: true });
    await fs.mkdir(path.dirname(managedStatePath), { recursive: true });
    await fs.mkdir(path.dirname(rootSessionPath), { recursive: true });
    await fs.mkdir(path.dirname(managedSessionPath), { recursive: true });
    await fs.writeFile(rootSessionPath, "root session\n");
    await fs.writeFile(managedSessionPath, "managed session\n");
    await fs.writeFile(
      chatStatePath,
      JSON.stringify({
        chatKey: "telegram/1:2",
        sessionFile: "chat-root.jsonl",
      }),
    );
    await fs.writeFile(
      managedStatePath,
      JSON.stringify({
        chatKey: "telegram/1:3",
        sessionFile: "managed/chat/already.jsonl",
      }),
    );

    const result = persist.normalizeInstalledChatSettings(
      {
        targetUser: "demo",
        installDir: dir,
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000 }),
        readInstallerJson: (_filePath, fallback) => fallback,
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: () => {},
        runPrivileged: () => {},
      },
    );

    const targetSessionPath = path.join(
      dir,
      "sessions",
      "managed",
      "chat",
      "chat-root.jsonl",
    );
    assert.deepEqual(JSON.parse(await fs.readFile(chatStatePath, "utf8")), {
      chatKey: "telegram/1:2",
      sessionFile: "managed/chat/chat-root.jsonl",
    });
    assert.deepEqual(JSON.parse(await fs.readFile(managedStatePath, "utf8")), {
      chatKey: "telegram/1:3",
      sessionFile: "managed/chat/already.jsonl",
    });
    assert.equal(
      await fs.readFile(targetSessionPath, "utf8"),
      "root session\n",
    );
    await assert.rejects(fs.access(rootSessionPath));
    assert.equal(result.migrations[2].id, "chat-session-managed-file-v1");
    assert.equal(result.migrations[2].skipped, false);
    assert.equal(result.migrations[2].scanned, 2);
    assert.equal(result.migrations[2].migrated, 1);
    assert.deepEqual(result.migrations[2].migratedFiles, [targetSessionPath]);
    await fs.access(result.migrations[2].markerPath);
  });
});

test("persist persistInstallerOutputs normalizes malformed chat roots before merging adapters", async () => {
  await withTempDir(async (dir) => {
    const ownerHome = path.join(dir, "home", "demo");
    const writes = [];
    const result = await persist.persistInstallerOutputs(
      {
        currentUser: "operator",
        targetUser: "demo",
        installDir: dir,
        provider: "openai",
        modelId: "gpt",
        thinkingLevel: "medium",
        chatConfig: { telegram: { token: "fresh-token" } },
        authData: { apiKey: "secret" },
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000, home: ownerHome }),
        ensureDir: () => {},
        readInstallerJson: (filePath, fallback) => {
          if (filePath === path.join(dir, "settings.json")) {
            return {
              chat: "broken",
              koishi: { telegram: { token: "legacy" } },
            };
          }
          if (filePath === path.join(dir, "auth.json")) {
            return { existing: true };
          }
          return fallback;
        },
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
        launcherMetadataPathForUser: () => path.join(dir, "launcher.json"),
        readJsonFile: (_filePath, fallback) => fallback,
        writeLaunchersForUser: () => ({
          rinPath: "/tmp/rin",
          rinInstallPath: "/tmp/rin-install",
        }),
        reconcileInstallerManifest: persist.reconcileInstallerManifest,
        runPrivileged: () => {},
      },
    );

    const settingsWrite = writes.find(
      (entry) => entry.filePath === result.settingsPath,
    );
    assert.ok(settingsWrite);
    assert.deepEqual(settingsWrite.value.chat, {
      telegram: { token: "fresh-token" },
    });
    assert.equal("koishi" in settingsWrite.value, false);

    const authWrite = writes.find(
      (entry) => entry.filePath === result.authPath,
    );
    assert.ok(authWrite);
    assert.deepEqual(authWrite.value, { existing: true, apiKey: "secret" });
  });
});

test("persist persistInstallerOutputs applies install upgrade migrations before finishing install state", async () => {
  await withTempDir(async (dir) => {
    const ownerHome = path.join(dir, "home", "demo");
    const previousStoreDir = path.join(dir, "data", "koishi-message-store");
    const currentStoreDir = path.join(dir, "data", "chat-message-store");
    await fs.mkdir(previousStoreDir, { recursive: true });
    await fs.writeFile(
      path.join(previousStoreDir, "marker.txt"),
      "old\n",
      "utf8",
    );

    const result = await persist.persistInstallerOutputs(
      {
        currentUser: "operator",
        targetUser: "demo",
        installDir: dir,
        provider: "openai",
        modelId: "gpt",
        thinkingLevel: "medium",
        chatConfig: {},
        authData: {},
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000, home: ownerHome }),
        ensureDir: () => {},
        readInstallerJson: (_filePath, fallback) => fallback,
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: () => {},
        launcherMetadataPathForUser: () => path.join(dir, "launcher.json"),
        readJsonFile: (_filePath, fallback) => fallback,
        writeLaunchersForUser: () => ({
          rinPath: "/tmp/rin",
          rinInstallPath: "/tmp/rin-install",
        }),
        reconcileInstallerManifest: persist.reconcileInstallerManifest,
        runPrivileged: () => {},
      },
    );

    await fs.access(path.join(currentStoreDir, "marker.txt"));
    await assert.rejects(fs.access(path.join(previousStoreDir, "marker.txt")));
    assert.deepEqual(result.migrations, [
      {
        id: "chat-message-store-dir",
        fromPath: previousStoreDir,
        toPath: currentStoreDir,
        moved: true,
        skipped: false,
      },
      {
        id: "chat-state-session-file-v1",
        markerPath: path.join(
          dir,
          "data",
          "migrations",
          "chat-state-session-file-v1.json",
        ),
        alreadyApplied: false,
        skipped: true,
        scanned: 0,
        migrated: 0,
        migratedFiles: [],
      },
      {
        id: "chat-session-managed-file-v1",
        markerPath: path.join(
          dir,
          "data",
          "migrations",
          "chat-session-managed-file-v1.json",
        ),
        alreadyApplied: false,
        skipped: true,
        scanned: 0,
        migrated: 0,
        migratedFiles: [],
      },
    ]);
    await assert.rejects(fs.access(result.migrations[1].markerPath));
    await assert.rejects(fs.access(result.migrations[2].markerPath));
  });
});

test("persist persistInstallerOutputs forwards release metadata into installer manifests", async () => {
  await withTempDir(async (dir) => {
    const ownerHome = path.join(dir, "home", "demo");
    const writes = [];

    await persist.persistInstallerOutputs(
      {
        currentUser: "operator",
        targetUser: "demo",
        installDir: dir,
        provider: "openai",
        modelId: "gpt",
        thinkingLevel: "medium",
        chatConfig: null,
        authData: {},
        release: {
          channel: "git",
          version: "deadbeef",
          branch: "main",
          ref: "deadbeef",
          sourceLabel: "git ref deadbeef",
          archiveUrl: "https://example.com/rin-deadbeef.tar.gz",
          installedAt: "2026-04-20T11:00:00.000Z",
        },
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000, home: ownerHome }),
        ensureDir: () => {},
        readInstallerJson: (_filePath, fallback) => fallback,
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
        launcherMetadataPathForUser: () => path.join(dir, "launcher.json"),
        readJsonFile: (_filePath, fallback) => fallback,
        writeLaunchersForUser: () => ({
          rinPath: "/tmp/rin",
          rinInstallPath: "/tmp/rin-install",
        }),
        reconcileInstallerManifest: persist.reconcileInstallerManifest,
        runPrivileged: () => {},
      },
    );

    const manifestWrites = writes.filter(
      (entry) =>
        entry.filePath.endsWith(path.join(".rin", "installer.json")) ||
        entry.filePath.endsWith(path.join(dir, "installer.json")),
    );
    assert.equal(manifestWrites.length >= 1, true);
    for (const entry of manifestWrites) {
      assert.deepEqual(entry.value.release, {
        channel: "git",
        version: "deadbeef",
        branch: "main",
        ref: "deadbeef",
        sourceLabel: "git ref deadbeef",
        archiveUrl: "https://example.com/rin-deadbeef.tar.gz",
        installedAt: "2026-04-20T11:00:00.000Z",
      });
    }
  });
});

test("persist persistInstallerOutputs can skip saving a launcher default target", async () => {
  await withTempDir(async (dir) => {
    const ownerHome = path.join(dir, "home", "demo");
    const writes = [];
    const result = await persist.persistInstallerOutputs(
      {
        currentUser: "operator",
        targetUser: "demo",
        installDir: dir,
        provider: "openai",
        modelId: "gpt",
        thinkingLevel: "medium",
        setDefaultTarget: false,
        chatConfig: null,
        authData: {},
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000, home: ownerHome }),
        ensureDir: () => {},
        readInstallerJson: (_filePath, fallback) => fallback,
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
        launcherMetadataPathForUser: () => path.join(dir, "launcher.json"),
        readJsonFile: () => ({
          defaultTargetUser: "stale-user",
          defaultInstallDir: "/srv/stale-dir",
        }),
        writeLaunchersForUser: () => ({
          rinPath: "/tmp/rin",
          rinInstallPath: "/tmp/rin-install",
        }),
        reconcileInstallerManifest: persist.reconcileInstallerManifest,
        runPrivileged: () => {},
      },
    );

    const launcherWrite = writes.find(
      (entry) => entry.filePath === result.launcherPath,
    );
    assert.ok(launcherWrite);
    assert.equal("defaultTargetUser" in launcherWrite.value, false);
    assert.equal("defaultInstallDir" in launcherWrite.value, false);
    assert.equal(launcherWrite.value.installedBy, "operator");
    assert.match(launcherWrite.value.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("persist persistInstallerOutputs writes launchers for current and target users", async () => {
  await withTempDir(async (dir) => {
    const ownerHome = path.join(dir, "home", "demo");
    const launcherCalls = [];
    const result = await persist.persistInstallerOutputs(
      {
        currentUser: "operator",
        targetUser: "demo",
        installDir: dir,
        provider: "openai",
        modelId: "gpt",
        thinkingLevel: "medium",
        chatConfig: null,
        authData: {},
        elevated: true,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000, home: ownerHome }),
        ensureDir: () => {},
        readInstallerJson: (_filePath, fallback) => fallback,
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: () => {},
        launcherMetadataPathForUser: () => path.join(dir, "launcher.json"),
        readJsonFile: (_filePath, fallback) => fallback,
        writeLaunchersForUser: (userName, _installDir, options) => {
          launcherCalls.push({ userName, options });
          return {
            rinPath: path.join(dir, userName, "rin"),
            rinInstallPath: path.join(dir, userName, "rin-install"),
          };
        },
        reconcileInstallerManifest: persist.reconcileInstallerManifest,
        runPrivileged: () => {},
      },
    );

    assert.deepEqual(launcherCalls, [
      { userName: "operator", options: { elevated: false } },
      { userName: "demo", options: { elevated: true } },
    ]);
    assert.equal(result.rinPath, path.join(dir, "operator", "rin"));
    assert.equal(
      result.rinInstallPath,
      path.join(dir, "operator", "rin-install"),
    );
    assert.equal(result.targetRinPath, path.join(dir, "demo", "rin"));
    assert.equal(
      result.targetRinInstallPath,
      path.join(dir, "demo", "rin-install"),
    );
  });
});

test("persist persistInstallerOutputs normalizes malformed auth and launcher metadata roots", async () => {
  await withTempDir(async (dir) => {
    const ownerHome = path.join(dir, "home", "demo");
    const writes = [];
    const result = await persist.persistInstallerOutputs(
      {
        currentUser: "operator",
        targetUser: "demo",
        installDir: dir,
        provider: "openai",
        modelId: "gpt",
        thinkingLevel: "medium",
        chatConfig: null,
        authData: { apiKey: "secret" },
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000, home: ownerHome }),
        ensureDir: () => {},
        readInstallerJson: (filePath, fallback) => {
          if (filePath === path.join(dir, "auth.json")) return [];
          return fallback;
        },
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
        launcherMetadataPathForUser: () => path.join(dir, "launcher.json"),
        readJsonFile: () => [],
        writeLaunchersForUser: () => ({
          rinPath: "/tmp/rin",
          rinInstallPath: "/tmp/rin-install",
        }),
        reconcileInstallerManifest: persist.reconcileInstallerManifest,
        runPrivileged: () => {},
      },
    );

    const authWrite = writes.find(
      (entry) => entry.filePath === result.authPath,
    );
    assert.ok(authWrite);
    assert.deepEqual(authWrite.value, { apiKey: "secret" });

    const launcherWrite = writes.find(
      (entry) => entry.filePath === result.launcherPath,
    );
    assert.ok(launcherWrite);
    assert.deepEqual(launcherWrite.value, {
      defaultTargetUser: "demo",
      defaultInstallDir: dir,
      updatedAt: launcherWrite.value.updatedAt,
      installedBy: "operator",
    });
    assert.match(launcherWrite.value.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});
