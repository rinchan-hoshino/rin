import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
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
const finalize = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "finalize.js"),
  ).href
);
const updateFenceCheck = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "app", "rin-install", "update-fence-check.js"),
  ).href
);

test("packaged update-fence helper validates its invocation", async () => {
  await assert.rejects(
    updateFenceCheck.main([]),
    /rin_update_fence_check_args_missing/,
  );
});

test("finalize uses a 30 second default daemon readiness timeout", () => {
  assert.equal(finalize.defaultDaemonReadyTimeoutMs(), 30_000);
});

test("finalize does not treat a non-empty install dir as initialized without init state", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "settings.json"), "{}", "utf8");

    assert.equal(finalize.readExistingInitializationComplete(dir), false);
  });
});

test("finalize preserves completed initialization state on reinstall", async () => {
  await withTempDir(async (dir) => {
    await fs.mkdir(path.join(dir, "self_improve", "state"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(dir, "self_improve", "state", "init-state.json"),
      JSON.stringify({ version: 2, initialized: true }),
      "utf8",
    );

    assert.equal(finalize.readExistingInitializationComplete(dir), true);
  });
});

test("finalize treats legacy completedAt initialization state as complete", async () => {
  await withTempDir(async (dir) => {
    await fs.mkdir(path.join(dir, "self_improve", "state"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(dir, "self_improve", "state", "init-state.json"),
      JSON.stringify({ version: 2, completedAt: "2026-07-04T00:00:00.000Z" }),
      "utf8",
    );

    assert.equal(finalize.readExistingInitializationComplete(dir), true);
  });
});

function createNoopSpinner() {
  return {
    start() {},
    stop() {},
    message() {},
  };
}

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
      "Rin home: /home/demo/.rin",
    ].join("\n"),
    "Update plan",
  );

  assert.match(rendered, /◇ {2}Update plan/);
  assert.match(rendered, /│ {2}Current user: demo/);
  assert.match(rendered, /│ {2}Selected daemon user: demo/);
  assert.match(rendered, /├─+╯/);
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
            models: [
              {
                id: "llama-test",
                reasoning: true,
                thinkingLevelMap: { xhigh: "xhigh", max: null },
              },
            ],
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
        (model) =>
          model.provider === "openai" &&
          model.available === true &&
          model.authKind === "api",
      ),
    );
    assert.ok(
      choices.some(
        (model) =>
          model.provider === "openai-codex" &&
          model.authKind === "subscription" &&
          String(model.providerLabel || "").includes("Codex"),
      ),
    );
    const localModel = choices.find(
      (model) => model.provider === "local-test" && model.id === "llama-test",
    );
    assert.equal(localModel?.reasoning, true);
    assert.equal(localModel?.available, true);
    assert.deepEqual(localModel?.thinkingLevelMap, {
      xhigh: "xhigh",
      max: null,
    });
  });
});

test("provider-auth exposes OpenAI Codex OAuth during installer authentication", async () => {
  await withTempDir(async (dir) => {
    const authStorage = await provider.createInstallerAuthStorage(
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
      authStorage
        .getOAuthProviders()
        .some((entry) => entry.id === "openai-codex"),
    );
  });
});

test("provider-auth forwards OAuth device-code callbacks during installer login", async () => {
  let deviceCodeSeen = false;
  const result = await provider.configureProviderAuth(
    "openai-codex",
    "/tmp/rin-demo",
    {
      readJsonFile: (_filePath: string, fallback: any) => fallback,
      ensureNotCancelled(value: any) {
        return value;
      },
      spinnerFactory: createNoopSpinner,
      copy: {
        loadingModelChoicesMessage: "loading",
        installStepComplete: "ok",
        installStepFailed: "failed",
        startingLogin: () => "starting",
        openUrlToContinueLogin(url: string, instructions?: string) {
          assert.equal(url, "https://example.com/device");
          assert.equal(instructions, "code: ABCD-EFGH");
          return "open device url";
        },
        deviceCodeLoginInstructions(userCode: string) {
          assert.equal(userCode, "ABCD-EFGH");
          return `code: ${userCode}`;
        },
        enterLoginValueMessage: "enter",
        waitingForLogin: () => "waiting",
        manualCodeInputMessage: "manual",
        manualCodePlaceholder: () => "placeholder",
        loginComplete: () => "complete",
        loginFailed: () => "failed",
        enterApiKeyMessage: () => "api key",
        valueRequired: "required",
        tokenRequired: "token required",
      },
      async createAuthStorage() {
        return {
          hasAuth() {
            return false;
          },
          getOAuthProviders() {
            return [
              {
                id: "openai-codex",
                name: "ChatGPT Plus/Pro (Codex Subscription)",
              },
            ];
          },
          async login(_providerId: string, callbacks: any) {
            callbacks.onDeviceCode({
              verificationUri: "https://example.com/device",
              userCode: "ABCD-EFGH",
            });
            deviceCodeSeen = true;
          },
          getAll() {
            return { "openai-codex": { type: "oauth" } };
          },
        };
      },
    },
  );

  assert.equal(deviceCodeSeen, true);
  assert.equal(result.authKind, "oauth");
  assert.equal(result.available, true);
});

test("provider-auth honors OAuth prompts that allow empty input", async () => {
  let promptedValue = "not-called";
  let validateResult: any = "not-called";
  const result = await provider.configureProviderAuth(
    "github-copilot",
    "/tmp/rin-demo",
    {
      readJsonFile: (_filePath: string, fallback: any) => fallback,
      ensureNotCancelled(value: any) {
        return value;
      },
      spinnerFactory: createNoopSpinner,
      async createAuthStorage() {
        return {
          hasAuth() {
            return false;
          },
          getOAuthProviders() {
            return [{ id: "github-copilot", name: "GitHub Copilot" }];
          },
          async login(_providerId: string, callbacks: any) {
            promptedValue = await callbacks.onPrompt({
              message: "GitHub Enterprise URL/domain (blank for github.com)",
              placeholder: "company.ghe.com",
              allowEmpty: true,
            });
          },
          getAll() {
            return { "github-copilot": { type: "oauth" } };
          },
        };
      },
      async textPrompt(options: any) {
        validateResult = options.validate("");
        return "";
      },
    },
  );

  assert.equal(validateResult, undefined);
  assert.equal(promptedValue, "");
  assert.equal(result.authKind, "oauth");
  assert.equal(result.available, true);
});

test("provider-auth forwards OAuth select prompts during installer login", async () => {
  let selectedValue = "";
  let selectOptions: any;
  const result = await provider.configureProviderAuth(
    "openai-codex",
    "/tmp/rin-demo",
    {
      readJsonFile: (_filePath: string, fallback: any) => fallback,
      ensureNotCancelled(value: any) {
        return value;
      },
      spinnerFactory: createNoopSpinner,
      async createAuthStorage() {
        return {
          hasAuth() {
            return false;
          },
          getOAuthProviders() {
            return [
              {
                id: "openai-codex",
                name: "ChatGPT Plus/Pro (Codex Subscription)",
              },
            ];
          },
          async login(_providerId: string, callbacks: any) {
            selectedValue = await callbacks.onSelect({
              message: "Choose login method",
              options: [
                { id: "browser", label: "Browser" },
                { id: "device", label: "Device code" },
              ],
            });
          },
          getAll() {
            return { "openai-codex": { type: "oauth" } };
          },
        };
      },
      async selectPrompt(options: any) {
        selectOptions = options;
        return "device";
      },
    },
  );

  assert.equal(selectedValue, "device");
  assert.deepEqual(selectOptions, {
    message: "Choose login method",
    options: [
      { value: "browser", label: "Browser" },
      { value: "device", label: "Device code" },
    ],
  });
  assert.equal(result.authKind, "oauth");
  assert.equal(result.available, true);
});
test("persist reconcileInstallerManifest writes only install metadata for non-home Rin paths", async () => {
  await withTempDir(async (dir) => {
    const installDir = path.join(dir, "srv", "rin-demo");
    const ownerHome = path.join(dir, "home", "demo");
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
    for (const entry of writes) {
      assert.equal(entry.value.targetUser, "demo");
      assert.equal(entry.value.installDir, installDir);
      assert.equal("defaultProvider" in entry.value, false);
      assert.equal("defaultModel" in entry.value, false);
      assert.equal("defaultThinkingLevel" in entry.value, false);
      assert.equal("language" in entry.value, false);
      assert.equal("chat" in entry.value, false);
      assert.equal("koishi" in entry.value, false);
    }
  });
});

test("persist reconcileInstallerManifest migrates managed files into installer manifest", async () => {
  await withTempDir(async (dir) => {
    const installDir = path.join(dir, "srv", "rin-demo");
    const ownerHome = path.join(dir, "home", "demo");
    const legacyPath = path.join(
      installDir,
      "data",
      ".managed",
      "install-home.json",
    );
    const writes = [];
    const removed = [];

    persist.reconcileInstallerManifest(
      {
        targetUser: "demo",
        installDir,
        managedFiles: {
          trees: {
            "docs/rin": ["README.md", "docs/runtime-layout.md"],
          },
        },
        elevated: true,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000, home: ownerHome }),
        ensureDir: async () => {},
        readInstallerJson: (filePath, fallback) => {
          if (filePath === legacyPath) {
            return {
              version: 1,
              trees: {
                extensions: ["init.ts"],
                "docs/rin": ["stale.md"],
              },
            };
          }
          return fallback;
        },
        writeJsonFileWithPrivilege: (filePath, value) =>
          writes.push({ filePath, value }),
        writeJsonFile: () => {},
        runPrivileged: (command, args) => removed.push([command, ...args]),
      },
    );

    assert.equal(writes.length, 2);
    for (const entry of writes) {
      assert.deepEqual(entry.value.managedFiles, {
        trees: {
          extensions: ["init.ts"],
          "docs/rin": ["README.md", "docs/runtime-layout.md"],
        },
      });
      assert.equal("version" in entry.value.managedFiles, false);
    }
    assert.deepEqual(removed, [["rm", "-f", legacyPath]]);
  });
});

test("persist reconcileInstallerManifest stores release metadata on currentRelease only", async () => {
  await withTempDir(async (dir) => {
    const installDir = path.join(dir, "srv", "rin-demo");
    const ownerHome = path.join(dir, "home", "demo");
    const writes = [];
    const betaRelease = {
      channel: "beta" as const,
      version: "1.3.0-beta.2",
      branch: "release/1.3",
      ref: "1.3.0-beta.2",
      sourceLabel: "beta version 1.3.0-beta.2",
      archiveUrl: "https://example.com/release-1.3-beta.2.tgz",
      installedAt: "2026-04-20T10:00:00.000Z",
    };

    persist.reconcileInstallerManifest(
      {
        targetUser: "demo",
        installDir,
        release: betaRelease,
        currentReleaseName: "1.3.0-beta.2",
        currentReleaseRoot: path.join(
          installDir,
          "app",
          "releases",
          "1.3.0-beta.2",
        ),
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
      assert.equal("release" in entry.value, false);
      assert.equal(entry.value.currentRelease.name, "1.3.0-beta.2");
      assert.deepEqual(entry.value.currentRelease.release, betaRelease);
    }

    const nightlyWrites = [];
    persist.reconcileInstallerManifest(
      {
        targetUser: "demo",
        installDir,
        release: {
          channel: "nightly",
          version: "1.4.0-nightly.20260513+abc1234",
          branch: "main",
          ref: "abc1234",
          sourceLabel: "nightly 1.4.0-nightly.20260513+abc1234",
          archiveUrl: "https://example.com/nightly.tgz",
        },
        currentReleaseName: "1.4.0-nightly.20260513+abc1234",
        currentReleaseRoot: path.join(
          installDir,
          "app",
          "releases",
          "1.4.0-nightly.20260513+abc1234",
        ),
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000, home: ownerHome }),
        ensureDir: async () => {},
        readInstallerJson: (_filePath, fallback) => fallback,
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: (filePath, value) =>
          nightlyWrites.push({ filePath, value }),
        runPrivileged: () => {},
      },
    );

    for (const entry of nightlyWrites) {
      assert.equal("release" in entry.value, false);
      assert.equal(entry.value.currentRelease.release.channel, "nightly");
      assert.equal(
        entry.value.currentRelease.release.version,
        "1.4.0-nightly.20260513+abc1234",
      );
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
              currentRelease: {
                name: "1.2.0",
                path: path.join(installDir, "app", "releases", "1.2.0"),
                release: {
                  channel: "stable",
                  version: "1.2.0",
                  branch: "stable",
                  ref: "1.2.0",
                  sourceLabel: "stable version 1.2.0",
                  archiveUrl: "https://example.com/release-1.2.0.tgz",
                },
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
      assert.equal("release" in entry.value, false);
      assert.equal(entry.value.currentRelease.name, "1.3.0");
      assert.equal(entry.value.currentRelease.release.version, "1.3.0");
      assert.equal(entry.value.previousRelease.name, "1.2.0");
      assert.equal(entry.value.previousRelease.release.version, "1.2.0");
    }
  });
});

test("persist reconcileInstallerManifest preserves the last valid rollback point when current identity is unknown", async () => {
  await withTempDir(async (dir) => {
    const installDir = path.join(dir, "srv", "rin-demo");
    const ownerHome = path.join(dir, "home", "demo");
    const writes = [];
    const validPrevious = {
      name: "3374adcfb9c9",
      path: path.join(installDir, "app", "releases", "3374adcfb9c9"),
      release: {
        channel: "git",
        version: "3374adcfb9c9",
        branch: "main",
        ref: "3374adcfb9c9c65c1b39498d81818fd8ff3a16b0",
        sourceLabel: "git branch main @ 3374adcfb9c9",
        archiveUrl:
          "https://example.com/rin/archive/3374adcfb9c9c65c1b39498d81818fd8ff3a16b0.tar.gz",
      },
    };
    const priorManifest = {
      currentRelease: {
        name: "unknown",
        path: path.join(installDir, "app", "releases", "unknown"),
        release: {
          channel: "git",
          version: "unknown",
          branch: "main",
          ref: "",
          sourceLabel: "git branch main",
          archiveUrl: "https://example.com/rin/archive/main.tar.gz",
        },
      },
      previousRelease: validPrevious,
    };

    persist.reconcileInstallerManifest(
      {
        targetUser: "demo",
        installDir,
        release: {
          channel: "git",
          version: "eae70b642bdd",
          branch: "main",
          ref: "eae70b642bddceff1c416a3126467b106d7065d1",
          sourceLabel: "git ref eae70b642bddceff1c416a3126467b106d7065d1",
          archiveUrl:
            "https://example.com/rin/archive/eae70b642bddceff1c416a3126467b106d7065d1.tar.gz",
        },
        currentReleaseName: "eae70b642bdd",
        currentReleaseRoot: path.join(
          installDir,
          "app",
          "releases",
          "eae70b642bdd",
        ),
        previousReleaseName: "unknown",
        previousReleaseRoot: path.join(
          installDir,
          "app",
          "releases",
          "unknown",
        ),
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000, home: ownerHome }),
        ensureDir: () => {},
        readInstallerJson: (_filePath, fallback) =>
          fallback === null ? priorManifest : fallback,
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
        runPrivileged: () => {},
      },
    );

    assert.equal(writes.length, 2);
    for (const entry of writes) {
      assert.equal(entry.value.currentRelease.name, "eae70b642bdd");
      assert.equal(entry.value.previousRelease.name, validPrevious.name);
      assert.equal(
        entry.value.previousRelease.release.ref,
        validPrevious.release.ref,
      );
    }
  });
});

test("persist reconcileInstallerManifest reuses only currentRelease state from prior manifests", async () => {
  await withTempDir(async (dir) => {
    const installDir = path.join(dir, "srv", "rin-demo");
    const ownerHome = path.join(dir, "home", "demo");
    const writes = [];
    const readCalls = [];

    persist.reconcileInstallerManifest(
      {
        targetUser: "demo",
        installDir,
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000, home: ownerHome }),
        ensureDir: async () => {},
        readInstallerJson: (filePath, fallback) => {
          readCalls.push(filePath);
          if (filePath === path.join(installDir, "installer.json")) return [];
          if (filePath === path.join(ownerHome, ".rin", "installer.json")) {
            return {
              preserved: true,
              defaultModel: "existing-model",
              release: {
                channel: "git",
                version: "poison",
                branch: "main",
                ref: "poison",
                sourceLabel: "ignored top-level release",
                archiveUrl: "https://example.com/ignored.tar.gz",
              },
              currentRelease: {
                name: "abc1234",
                path: path.join(installDir, "app", "releases", "abc1234"),
                release: {
                  channel: "git",
                  version: "abc1234",
                  branch: "main",
                  ref: "abc1234",
                  sourceLabel: "git ref abc1234",
                  archiveUrl: "https://example.com/rin.tar.gz",
                },
              },
            };
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
      path.join(installDir, "data", ".managed", "install-home.json"),
    ]);
    assert.equal(writes.length, 2);
    for (const entry of writes) {
      assert.equal("preserved" in entry.value, false);
      assert.equal("defaultModel" in entry.value, false);
      assert.equal("defaultProvider" in entry.value, false);
      assert.equal("release" in entry.value, false);
      assert.equal(entry.value.currentRelease.name, "abc1234");
      assert.equal(entry.value.currentRelease.release.version, "abc1234");
    }
  });
});

test("persist reconcileInstallerManifest avoids duplicate writes for default Rin paths", async () => {
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

test("persist reconcileInstallerManifest records the managed runtime service", async () => {
  await withTempDir(async (dir) => {
    const ownerHome = path.join(dir, "home", "demo");
    const installDir = path.join(ownerHome, ".rin");
    const writes = [];
    persist.reconcileInstallerManifest(
      {
        targetUser: "demo",
        installDir,
        elevated: false,
        service: {
          kind: "systemd",
          label: "rin-daemon-demo.service",
          path: path.join(
            ownerHome,
            ".config/systemd/user/rin-daemon-demo.service",
          ),
        },
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

    assert.deepEqual(writes[0].value.service, {
      kind: "systemd",
      label: "rin-daemon-demo.service",
      path: path.join(
        ownerHome,
        ".config/systemd/user/rin-daemon-demo.service",
      ),
    });
  });
});

test("persist reconcileInstallerManifest keeps runtime defaults out of installer manifests", async () => {
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
    assert.equal(writes[0].value.targetUser, "demo");
    assert.equal(writes[0].value.installDir, installDir);
    assert.equal("defaultProvider" in writes[0].value, false);
    assert.equal("defaultModel" in writes[0].value, false);
    assert.equal("defaultThinkingLevel" in writes[0].value, false);
    assert.equal("language" in writes[0].value, false);
  });
});

test("persist reconcileInstallerManifest removes chat settings from installer manifests", async () => {
  await withTempDir(async (dir) => {
    const installDir = path.join(dir, "srv", "rin-demo");
    const ownerHome = path.join(dir, "home", "demo");
    const writes = [];

    persist.reconcileInstallerManifest(
      {
        targetUser: "demo",
        installDir,
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
      assert.equal("chat" in entry.value, false);
      assert.equal("defaultProvider" in entry.value, false);
    }
  });
});

test("persistInstallerOutputs creates the runtime user skill directory", async () => {
  await withTempDir(async (dir) => {
    const ensured = [];
    await persist.persistInstallerOutputs(
      {
        currentUser: "alice",
        targetUser: "demo",
        installDir: dir,
        provider: "openai",
        modelId: "gpt",
        thinkingLevel: "medium",
        authData: {},
        elevated: false,
        writeLaunchers: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000 }),
        ensureDir: (dirPath) => ensured.push(dirPath),
        readInstallerJson: (_filePath, fallback) => fallback,
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: () => {},
        launcherMetadataPathForUser: () => path.join(dir, "launcher.json"),
        readJsonFile: (_filePath, fallback) => fallback,
        writeLaunchersForUser: () => ({}),
        reconcileInstallerManifest: persist.reconcileInstallerManifest,
        runPrivileged: () => {},
      },
    );

    assert.equal(ensured.includes(dir), true);
    assert.equal(
      ensured.includes(path.join(dir, "self_improve", "skills")),
      true,
    );
  });
});

test("persistInstallerOutputs creates elevated runtime user skill directory as target user", async () => {
  await withTempDir(async (dir) => {
    const commands = [];
    await persist.persistInstallerOutputs(
      {
        currentUser: "alice",
        targetUser: "demo",
        installDir: dir,
        provider: "openai",
        modelId: "gpt",
        thinkingLevel: "medium",
        authData: {},
        elevated: true,
        writeLaunchers: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000 }),
        ensureDir: () => {
          throw new Error("elevated user dir should be created as target user");
        },
        readInstallerJson: (_filePath, fallback) => fallback,
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: () => {},
        launcherMetadataPathForUser: () => path.join(dir, "launcher.json"),
        readJsonFile: (_filePath, fallback) => fallback,
        writeLaunchersForUser: () => ({}),
        reconcileInstallerManifest: persist.reconcileInstallerManifest,
        runPrivileged: () => {},
        runCommandAsUser: (targetUser, command, args) =>
          commands.push([targetUser, command, ...args]),
      },
    );

    assert.deepEqual(commands, [
      ["demo", "mkdir", "-p", path.join(dir, "self_improve", "skills")],
    ]);
  });
});

test("persistInstallerOutputs removes legacy language and preserves extension entries", async () => {
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
        authData: {},
        elevated: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000 }),
        ensureDir: async () => {},
        readInstallerJson: (filePath, fallback) =>
          String(filePath).endsWith("settings.json")
            ? {
                language: "zh_CN",
                extensions: ["owner-extension", "/opt/custom-extension"],
              }
            : fallback,
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
    assert.equal(Object.hasOwn(settingsWrite.value, "language"), false);
    assert.deepEqual(settingsWrite.value.extensions, [
      "owner-extension",
      "/opt/custom-extension",
    ]);

    const manifestWrites = writes.filter(
      (entry) =>
        entry.filePath === result.manifestPath ||
        entry.filePath === result.locatorManifestPath,
    );
    assert.equal(manifestWrites.length >= 1, true);
    for (const entry of manifestWrites) {
      assert.equal("defaultProvider" in entry.value, false);
      assert.equal("defaultModel" in entry.value, false);
      assert.equal("defaultThinkingLevel" in entry.value, false);
      assert.equal("language" in entry.value, false);
      assert.equal("chat" in entry.value, false);
    }
  });
});

test("persistInstallerOutputs marks fresh installs as needing initialization", async () => {
  await withTempDir(async (dir) => {
    const writes = [];
    const result = await persist.persistInstallerOutputs(
      {
        currentUser: "demo",
        targetUser: "demo",
        installDir: dir,
        provider: "openai",
        modelId: "gpt",
        thinkingLevel: "medium",
        authData: {},
        elevated: false,
        initializationComplete: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000, home: dir }),
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

    const initStateWrite = writes.find(
      (entry) => entry.filePath === result.initStatePath,
    );
    assert.ok(initStateWrite);
    assert.deepEqual(initStateWrite.value, {
      version: 2,
      promptedAt: "",
      completedAt: "",
      lastTrigger: "install_fresh",
      pending: false,
      initialized: false,
    });
  });
});

test("persist persistInstallerOutputs forwards release metadata into currentRelease", async () => {
  await withTempDir(async (dir) => {
    const ownerHome = path.join(dir, "home", "demo");
    const writes = [];
    const release = {
      channel: "git" as const,
      version: "deadbeef",
      branch: "main",
      ref: "deadbeef",
      sourceLabel: "git ref deadbeef",
      archiveUrl: "https://example.com/rin-deadbeef.tar.gz",
      installedAt: "2026-04-20T11:00:00.000Z",
    };

    await persist.persistInstallerOutputs(
      {
        currentUser: "operator",
        targetUser: "demo",
        installDir: dir,
        provider: "openai",
        modelId: "gpt",
        thinkingLevel: "medium",
        authData: {},
        release,
        currentReleaseName: "deadbeef",
        currentReleaseRoot: path.join(dir, "app", "releases", "deadbeef"),
        migrationRuntimeRoot: rootDir,
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
      assert.equal("release" in entry.value, false);
      assert.equal(entry.value.currentRelease.name, "deadbeef");
      assert.deepEqual(entry.value.currentRelease.release, release);
      assert.equal("defaultProvider" in entry.value, false);
      assert.equal("defaultModel" in entry.value, false);
      assert.equal("defaultThinkingLevel" in entry.value, false);
      assert.equal("chat" in entry.value, false);
    }
  });
});

test("persist reconcileInstallerManifest rejects git branch selectors as release identity", () => {
  const writes = [];
  assert.throws(
    () =>
      persist.reconcileInstallerManifest(
        {
          targetUser: "demo",
          installDir: "/tmp/rin",
          release: {
            channel: "git",
            version: "main",
            branch: "main",
            ref: "main",
            sourceLabel: "git branch main",
            archiveUrl: "https://example.invalid/main.tar.gz",
          },
          currentReleaseName: "main",
          currentReleaseRoot: "/tmp/rin/app/releases/main",
          elevated: false,
        },
        {
          findSystemUser: () => ({ name: "demo", home: "/home/demo" }),
          ensureDir: () => {},
          readInstallerJson: (_filePath, fallback) => fallback,
          writeJsonFileWithPrivilege: () => {},
          writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
          runPrivileged: () => {},
        },
      ),
    /rin_git_ref_not_resolved:main/,
  );
  assert.equal(writes.length, 0);
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

test("persist persistInstallerOutputs can skip launcher metadata and executable shims", async () => {
  await withTempDir(async (dir) => {
    const ownerHome = path.join(dir, "home", "demo");
    const writes = [];
    const launcherCalls = [];
    const result = await persist.persistInstallerOutputs(
      {
        currentUser: "operator",
        targetUser: "operator",
        installDir: dir,
        provider: "openai",
        modelId: "gpt",
        thinkingLevel: "medium",
        authData: {},
        elevated: false,
        writeLaunchers: false,
      },
      {
        findSystemUser: () => ({ name: "demo", gid: 1000, home: ownerHome }),
        ensureDir: () => {},
        readInstallerJson: (_filePath, fallback) => fallback,
        writeJsonFileWithPrivilege: () => {},
        writeJsonFile: (filePath, value) => writes.push({ filePath, value }),
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

    assert.equal("launcherPath" in result, false);
    assert.equal("currentRinPath" in result, false);
    assert.deepEqual(launcherCalls, []);
    assert.equal(
      writes.some(
        (entry) => entry.filePath === path.join(dir, "launcher.json"),
      ),
      false,
    );
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
