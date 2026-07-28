import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const interactive = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "interactive.js"),
  ).href
);
const installerI18n = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "i18n.js"))
    .href
);

test("installer interactive helpers describe dir state and plan text", () => {
  const existing = interactive.describeInstallDirState("/tmp/demo", {
    exists: true,
    entryCount: 2,
    sample: ["a", "b"],
  });
  assert.equal(existing.title, "Existing directory");
  assert.ok(existing.text.includes("keep unknown files untouched"));

  const created = interactive.describeInstallDirState("/tmp/demo", {
    exists: false,
    entryCount: 0,
    sample: [],
  });
  assert.equal(created.title, "Local Rin config");
  assert.ok(created.text.includes("Local Rin config will be created"));

  const plan = interactive.buildInstallPlanText({
    currentUser: "alice",
    targetUser: "bob",
    installDir: "/home/bob/.rin",
    provider: "openai",
    modelId: "gpt-5",
    thinkingLevel: "medium",
    authAvailable: true,
    setDefaultTarget: false,
  });
  assert.ok(plan.includes("Target daemon user: bob"));
  assert.ok(plan.includes("Model auth status: ready"));
  assert.ok(!plan.includes("Rin safety boundary:"));
  assert.ok(!plan.includes("TUI for the target user"));
  assert.ok(plan.includes("Default target user: not set"));
  assert.equal(plan.includes("Chat bridge:"), false);
  assert.equal(plan.includes("Chat authorization:"), false);

  const plainSection = interactive.buildPlainInstallerSection(
    "Install options",
    plan,
  );
  assert.ok(
    plainSection.startsWith("Install options\n  Target daemon user: bob"),
  );
  assert.ok(!plainSection.includes("╭"));

  const renderedZhNote = interactive.renderInstallerNote(
    "\u76ee\u5f55\u5c06\u4f1a\u521b\u5efa\uff1a/tmp/\u94c3\u9171\nASCII line",
    "\u5b89\u88c5\u76ee\u5f55",
  );
  const noteWidths = renderedZhNote
    .split("\n")
    .filter(Boolean)
    .slice(1)
    .map((line) => interactive.installerTextDisplayWidth(line));
  assert.equal(new Set(noteWidths).size, 1);
  assert.ok(renderedZhNote.includes("\u5b89\u88c5\u76ee\u5f55"));

  const wrapped = interactive.wrapInstallerNoteText(
    "- \u8fd9\u662f\u4e00\u884c\u8db3\u591f\u957f\u7684\u4e2d\u6587\u5b89\u88c5\u5668\u8bf4\u660e\uff0c\u9700\u8981\u5728\u8fdb\u5165 clack note \u524d\u5148\u6362\u884c\uff0c\u907f\u514d\u8fb9\u6846\u88ab\u957f\u884c\u6491\u574f\u3002",
    56,
  );
  assert.ok(wrapped.split("\n").length > 1);
  assert.ok(
    wrapped
      .split("\n")
      .every((line) => line.length <= 30 || line.startsWith("  ")),
  );

  const safety = interactive.buildInstallSafetyBoundaryText();
  assert.ok(safety.includes("YOLO mode"));
  assert.ok(safety.includes("memory extraction"));
  assert.ok(safety.includes("chat-bridge-triggered agent runs"));

  const fixedPlan = interactive.buildInstallPlanText({
    currentUser: "alice",
    targetUser: "bob",
    installDir: "/home/bob/.rin",
    provider: "openai",
    modelId: "gpt-5",
    thinkingLevel: "medium",
    authAvailable: true,
  });
  assert.doesNotMatch(fixedPlan, /Language:/);

  const fixedSafety = interactive.buildInstallSafetyBoundaryText();
  assert.ok(fixedSafety.includes("chat-bridge-triggered"));

  const initExit = interactive.buildPostInstallInitExitText({
    currentUser: "alice",
    targetUser: "bob",
  });
  assert.ok(initExit.includes("open Rin: rin -u bob"));
  assert.ok(initExit.includes("initialization completed state"));

  const launcherPath = "/home/alice/.local/bin/rin";
  const pathMissingInitExit = interactive.buildPostInstallInitExitText({
    currentUser: "alice",
    targetUser: "alice",
    rinPath: launcherPath,
    pathValue: "/usr/bin:/bin",
  });
  assert.ok(pathMissingInitExit.includes(`open Rin: ${launcherPath}`));
  assert.equal(pathMissingInitExit.includes("PATH note"), false);
  assert.equal(pathMissingInitExit.includes("export PATH"), false);

  const pathReadyInitExit = interactive.buildPostInstallInitExitText({
    currentUser: "alice",
    targetUser: "alice",
    rinPath: launcherPath,
    pathValue: "/home/alice/.local/bin:/usr/bin:/bin",
  });
  assert.ok(pathReadyInitExit.includes("open Rin: rin"));
  assert.equal(pathReadyInitExit.includes("PATH note"), false);

  const pathMissingOutro = interactive.buildInstallOutroText({
    currentUser: "alice",
    targetUser: "alice",
    rinPath: launcherPath,
    pathValue: "/usr/bin:/bin",
  });
  assert.ok(
    pathMissingOutro.includes("Open Rin after reopening your shell: rin"),
  );
  assert.ok(pathMissingOutro.includes(`Use now: ${launcherPath}`));
  assert.ok(
    pathMissingOutro.includes(
      "current shell PATH does not include /home/alice/.local/bin",
    ),
  );

  const pathReadyOutro = interactive.buildInstallOutroText({
    currentUser: "alice",
    targetUser: "alice",
    rinPath: launcherPath,
    pathValue: "/home/alice/.local/bin:/usr/bin:/bin",
  });
  assert.ok(pathReadyOutro.includes("Open Rin: rin"));
  assert.equal(pathReadyOutro.includes("reopening your shell"), false);
});

test("installer interactive helpers compute final requirements", () => {
  const elevated = interactive.buildFinalRequirements({
    installServiceNow: true,
    needsElevatedWrite: false,
    needsElevatedService: true,
  });
  assert.ok(elevated.some((line) => line.includes("use sudo/doas")));

  const local = interactive.buildFinalRequirements({
    installServiceNow: false,
    needsElevatedWrite: false,
    needsElevatedService: false,
  });
  assert.ok(
    local.some((line) => line.includes("skip daemon service installation")),
  );
});

test("installer target menu hides cross-user local install on Windows", () => {
  const linuxValues = interactive
    .buildInstallTargetOptions("alice", undefined, "linux")
    .map((option) => option.value);
  const windowsValues = interactive
    .buildInstallTargetOptions("alice", undefined, "win32")
    .map((option) => option.value);

  assert.ok(linuxValues.includes("local-user"));
  assert.equal(windowsValues.includes("local-user"), false);
  assert.deepEqual(windowsValues.slice(0, 2), ["current", "ssh"]);
});

test("promptTargetInstall falls back to all users when no other user exists", async () => {
  const seen = { selects: [], texts: [] };
  const result = await interactive.promptTargetInstall(
    {
      ensureNotCancelled(value) {
        return value;
      },
      async select(options) {
        seen.selects.push(options);
        return seen.selects.length === 1 ? "existing" : "alice";
      },
      async text(options) {
        seen.texts.push(options);
        return options.defaultValue;
      },
      async confirm() {
        throw new Error("confirm should not be used");
      },
    },
    "alice",
    [
      {
        name: "alice",
        uid: 1000,
        gid: 1000,
        home: "/home/alice",
        shell: "/bin/bash",
      },
    ],
    (user) => `/home/${user}`,
  );

  assert.equal(result.cancelled, false);
  assert.equal(result.targetUser, "alice");
  assert.equal(result.installDir, "/home/alice/.rin");
  assert.deepEqual(seen.texts, []);
  assert.deepEqual(
    result.existingCandidates.map((entry) => entry.name),
    ["alice"],
  );
  assert.deepEqual(
    seen.selects[1].options.map((option) => option.value),
    ["alice"],
  );
});

test("promptDefaultTargetUser returns the installer choice", async () => {
  const result = await interactive.promptDefaultTargetUser(
    {
      ensureNotCancelled(value) {
        return value;
      },
      async confirm() {
        return false;
      },
      async select() {
        throw new Error("select should not be used");
      },
      async text() {
        throw new Error("text should not be used");
      },
    },
    "bob",
  );

  assert.equal(result, false);
});

test("createInstallerI18n exposes fixed English install and update copy", () => {
  const i18n = installerI18n.createInstallerI18n();

  assert.equal(i18n.targetInstallDirLabel, "Rin home");
  assert.equal(i18n.writtenPathLabel, "Written");
  assert.equal(i18n.serviceLabelLabel, "label");
  assert.equal(i18n.confirmActiveLabel, "Yes");
  assert.equal(i18n.confirmInactiveLabel, "No");
  assert.equal(i18n.updaterIntroTitle, "Rin Updater");
  assert.equal(
    i18n.updateReinstallCurrentTitle,
    "Reinstalling current version",
  );
  assert.equal(
    i18n.fetchAndApplyUpdateConfirmMessage,
    "Fetch and apply this update now?",
  );
});

test("installer steps show progress after user input before work runs", () => {
  const sources = [
    "src/core/rin-install/main.ts",
    "src/core/rin-install/interactive.ts",
    "src/core/rin-install/provider-auth.ts",
    "src/core/rin-install/updater.ts",
  ]
    .map((item) => readFileSync(path.join(rootDir, item), "utf8"))
    .join("\n");

  assert.match(sources, /runInstallerProgress/);
  assert.match(sources, /applyingTargetSelectionMessage/);
  assert.match(sources, /inspectingInstallDirectoryMessage/);
  assert.match(sources, /loadingModelChoicesMessage/);
  assert.match(sources, /savingProviderAuthMessage/);
  assert.match(sources, /refreshingInstalledTargetMessage/);
});

test("core update preflights before stop and activates after migrations", () => {
  const source = readFileSync(
    path.join(rootDir, "src", "core", "rin-install", "finalize.ts"),
    "utf8",
  );
  const applyBlock = source.slice(
    source.indexOf("async function applyInstalledRuntime"),
    source.indexOf("export async function finalizeCoreUpdate"),
  );
  const preflightIndex = applyBlock.indexOf(
    "preflightInstallUpgradeMigrations",
  );
  const transitionIndex = applyBlock.indexOf("runManagedRuntimeTransition");
  const stopIndex = applyBlock.indexOf('"stop"', transitionIndex);
  const mutateIndex = applyBlock.indexOf("mutate: writeInstalledState");
  const activateIndex = applyBlock.indexOf("activate:", mutateIndex);
  const restartIndex = applyBlock.indexOf("restart:", activateIndex);

  assert.doesNotMatch(source, /stopInstalledBrowseSidecars/);
  assert.doesNotMatch(source, /prepareBrowseRuntime/);
  assert.doesNotMatch(source, /builtInExtensions/);
  assert.match(
    applyBlock,
    /deferRuntimeActivation = Boolean\(\s*publishRuntime && !persistInstallerState/,
  );
  assert.match(applyBlock, /activate: !deferRuntimeActivation/);
  assert.ok(preflightIndex >= 0 && preflightIndex < transitionIndex);
  assert.ok(stopIndex >= 0 && stopIndex < mutateIndex);
  assert.ok(mutateIndex >= 0 && mutateIndex < activateIndex);
  assert.ok(activateIndex >= 0 && activateIndex < restartIndex);
});

test("installer and updater source expose no language controls", () => {
  const mainSource = readFileSync(
    path.join(rootDir, "src", "core", "rin-install", "main.ts"),
    "utf8",
  );
  const i18nSource = readFileSync(
    path.join(rootDir, "src", "core", "rin-install", "i18n.ts"),
    "utf8",
  );
  const updaterSource = readFileSync(
    path.join(rootDir, "src", "core", "rin-install", "updater.ts"),
    "utf8",
  );

  assert.doesNotMatch(mainSource, /promptInstallerLanguage|--language/);
  assert.doesNotMatch(i18nSource, /zh_CN|Choose installer language/);
  assert.doesNotMatch(updaterSource, /readInstalledUpdateLanguage|--language/);
  assert.match(mainSource, /active: i18n\.confirmActiveLabel/);
  assert.match(updaterSource, /renderInstallerNote/);
  assert.match(updaterSource, /wrapInstallerNoteText/);
  assert.match(updaterSource, /selectUpdateTarget/);
  assert.match(updaterSource, /const i18n = initialI18n/);
  assert.match(updaterSource, /rin_update_confirmation_required/);
});

test("installer no longer prompts for bundled extension selection", () => {
  const source = readFileSync(
    path.join(rootDir, "src", "core", "rin-install", "interactive.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /promptBuiltInExtensionSetup/);
  assert.doesNotMatch(source, /Enable optional built-in extensions/);
});

test("promptProviderSetup reuses complete existing provider config", async () => {
  const installDir = "/tmp/demo";
  const result = await interactive.promptProviderSetup(
    {
      ensureNotCancelled(value) {
        return value;
      },
      async select() {
        throw new Error(
          "select should not be used for existing provider config",
        );
      },
      async text() {
        throw new Error("text should not be used for existing provider config");
      },
      async confirm() {
        throw new Error(
          "confirm should not be used for existing provider config",
        );
      },
    },
    installDir,
    (filePath) => {
      if (filePath === path.join(installDir, "settings.json")) {
        return {
          defaultProvider: "openai",
          defaultModel: "gpt-5",
          defaultThinkingLevel: "medium",
        };
      }
      if (filePath === path.join(installDir, "auth.json")) {
        return { openai: { type: "api_key", key: "demo" } };
      }
      return {};
    },
    {
      async loadModelChoices() {
        return [
          {
            provider: "openai",
            id: "gpt-5",
            reasoning: true,
            available: false,
          },
        ];
      },
      async configureProviderAuth() {
        throw new Error(
          "auth setup should not run for existing provider config",
        );
      },
    },
  );

  assert.equal(result.provider, "openai");
  assert.equal(result.modelId, "gpt-5");
  assert.equal(result.thinkingLevel, "medium");
  assert.equal(result.authResult.available, true);
  assert.equal(result.authResult.authKind, "existing");
});

test("promptProviderSetup does not reuse stale installer manifest provider config", async () => {
  const installDir = "/tmp/demo";
  const selectCalls = [];
  const result = await interactive.promptProviderSetup(
    {
      ensureNotCancelled(value) {
        return value;
      },
      async select(options) {
        selectCalls.push(options.message);
        return options.options[0].value;
      },
      async text() {
        return "secret";
      },
      async confirm() {
        return true;
      },
    },
    installDir,
    (filePath) => {
      if (filePath === path.join(installDir, "installer.json")) {
        return {
          defaultProvider: "openai",
          defaultModel: "gpt-5",
          defaultThinkingLevel: "medium",
        };
      }
      if (filePath === path.join(installDir, "auth.json")) {
        return { openai: { type: "api_key", key: "demo" } };
      }
      return {};
    },
    {
      async loadModelChoices() {
        return [
          {
            provider: "openai",
            id: "gpt-5",
            reasoning: true,
            available: false,
          },
        ];
      },
      async configureProviderAuth() {
        return { available: true, authKind: "existing", authData: {} };
      },
    },
  );

  assert.deepEqual(selectCalls, [
    "Choose a provider to authenticate and use.",
    "Choose a model.",
    "Choose the default thinking level.",
  ]);
  assert.equal(result.provider, "openai");
  assert.equal(result.modelId, "gpt-5");
  assert.equal(result.thinkingLevel, "off");
});

test("promptProviderSetup labels subscription and API providers with subscriptions first", async () => {
  let providerOptions: any[] = [];
  const prompt = {
    ensureNotCancelled(value: any) {
      return value;
    },
    async select(options: any) {
      if (options.message === "Choose a provider to authenticate and use.") {
        providerOptions = options.options;
        return "openai-codex";
      }
      if (options.message === "Choose a model.") return "gpt-5.5";
      if (options.message === "Choose the default thinking level.")
        return "medium";
      throw new Error(`unexpected select prompt: ${options.message}`);
    },
    async text() {
      throw new Error("text prompt should not be used in this test");
    },
    async confirm() {
      throw new Error("confirm should not be used in this test");
    },
  };

  await interactive.promptProviderSetup(prompt, "/tmp/demo", () => ({}), {
    async loadModelChoices() {
      return [
        {
          provider: "openai",
          providerLabel: "OpenAI",
          authKind: "api",
          id: "gpt-5",
          reasoning: true,
          available: false,
        },
        {
          provider: "openai-codex",
          providerLabel: "ChatGPT Plus/Pro (Codex)",
          authKind: "subscription",
          id: "gpt-5.5",
          reasoning: true,
          available: false,
        },
        {
          provider: "openai-codex",
          providerLabel: "ChatGPT Plus/Pro (Codex)",
          authKind: "subscription",
          id: "gpt-5.5-high",
          reasoning: true,
          available: false,
        },
      ];
    },
    async configureProviderAuth() {
      return {
        available: true,
        authKind: "oauth",
        authData: { "openai-codex": { type: "oauth" } },
      };
    },
  });

  assert.deepEqual(
    providerOptions.map((option) => option.value),
    ["openai-codex", "openai"],
  );
  assert.deepEqual(
    providerOptions.map((option) => option.label),
    ["ChatGPT Plus/Pro (Codex)", "OpenAI"],
  );
  assert.deepEqual(
    providerOptions.map((option) => option.hint),
    [
      "Subscription · 2 models · needs auth/config",
      "API · 1 model · needs auth/config",
    ],
  );
});

test("promptProviderSetup avoids repeating subscription in provider labels", async () => {
  const providerOptions = [];
  const prompt = {
    ensureNotCancelled(value) {
      return value;
    },
    async select(options) {
      if (options.message === "Choose a provider to authenticate and use.") {
        providerOptions.push(...options.options);
        return "openai-codex";
      }
      if (options.message === "Choose a model.") return "gpt-5.5";
      if (options.message === "Choose the default thinking level.")
        return "high";
      throw new Error(`unexpected select prompt: ${options.message}`);
    },
    async text() {
      throw new Error("text prompt should not be used in this test");
    },
    async confirm() {
      throw new Error("confirm prompt should not be used in this test");
    },
  };

  await interactive.promptProviderSetup(prompt, "/tmp/demo", () => ({}), {
    async loadModelChoices() {
      return [
        {
          provider: "openai-codex",
          providerLabel: "ChatGPT Plus/Pro (Codex Subscription)",
          authKind: "subscription",
          id: "gpt-5.5",
          reasoning: true,
          available: false,
        },
      ];
    },
    async configureProviderAuth() {
      return {
        available: true,
        authKind: "oauth",
        authData: { "openai-codex": { type: "oauth" } },
      };
    },
  });

  assert.deepEqual(
    providerOptions.map((option) => option.label),
    ["ChatGPT Plus/Pro (Codex)"],
  );
  assert.deepEqual(
    providerOptions.map((option) => option.hint),
    ["Subscription · 1 model · needs auth/config"],
  );
});

test("promptProviderSetup prompts when no reusable provider config exists", async () => {
  const selectCalls = [];
  const authCalls = [];
  const prompt = {
    ensureNotCancelled(value) {
      return value;
    },
    async select(options) {
      selectCalls.push(options.message);
      if (options.message === "Choose a provider to authenticate and use.")
        return "openai";
      if (options.message === "Choose a model.") return "gpt-5";
      if (options.message === "Choose the default thinking level.")
        return "medium";
      throw new Error(`unexpected select prompt: ${options.message}`);
    },
    async text() {
      throw new Error("text prompt should not be used in this test");
    },
    async confirm() {
      throw new Error(
        "provider setup must not allow skipping provider selection",
      );
    },
  };

  const result = await interactive.promptProviderSetup(
    prompt,
    "/tmp/demo",
    () => ({}),
    {
      async loadModelChoices() {
        return [
          {
            provider: "openai",
            id: "gpt-5",
            reasoning: true,
            available: false,
          },
          {
            provider: "openai",
            id: "gpt-4.1",
            reasoning: false,
            available: false,
          },
        ];
      },
      async configureProviderAuth(provider, installDir) {
        authCalls.push({ provider, installDir });
        return {
          available: true,
          authKind: "api_key",
          authData: { openai: { type: "api_key", key: "demo" } },
        };
      },
    },
  );

  assert.deepEqual(selectCalls, [
    "Choose a provider to authenticate and use.",
    "Choose a model.",
    "Choose the default thinking level.",
  ]);
  assert.deepEqual(authCalls, [
    { provider: "openai", installDir: "/tmp/demo" },
  ]);
  assert.equal(result.provider, "openai");
  assert.equal(result.modelId, "gpt-5");
  assert.equal(result.thinkingLevel, "medium");
  assert.equal(result.authResult.available, true);
});

test("promptProviderSetup fails when no models are available", async () => {
  await assert.rejects(
    interactive.promptProviderSetup(
      {
        ensureNotCancelled(value) {
          return value;
        },
        async select() {
          throw new Error("select should not be reached without models");
        },
        async text() {
          throw new Error("text should not be reached without models");
        },
        async confirm() {
          throw new Error("confirm should not be reached without models");
        },
      },
      "/tmp/demo",
      () => ({}),
      {
        async loadModelChoices() {
          return [];
        },
      },
    ),
    /rin_installer_no_models_available/,
  );
});
