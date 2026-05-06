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
  assert.equal(created.title, "Install directory");
  assert.ok(created.text.includes("Directory will be created"));

  const plan = interactive.buildInstallPlanText({
    currentUser: "alice",
    targetUser: "bob",
    installDir: "/home/bob/.rin",
    provider: "openai",
    modelId: "gpt-5",
    thinkingLevel: "medium",
    authAvailable: true,
    chatDescription: "telegram",
    chatDetail: "Chat bridge token: [saved]",
    setDefaultTarget: false,
  });
  assert.ok(plan.includes("Target daemon user: bob"));
  assert.ok(plan.includes("Model auth status: ready"));
  assert.ok(!plan.includes("Rin safety boundary:"));
  assert.ok(!plan.includes("TUI for the target user"));
  assert.ok(plan.includes("Default target user: not set"));
  assert.ok(plan.includes("Chat bridge: telegram"));
  assert.ok(
    plan.includes(
      "Chat authorization: installer guidance covers the first OWNER setup once; later role changes should be requested in normal conversation, not slash commands.",
    ),
  );

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

  const zhPlan = interactive.buildInstallPlanText(
    {
      currentUser: "alice",
      targetUser: "bob",
      installDir: "/home/bob/.rin",
      provider: "openai",
      modelId: "gpt-5",
      thinkingLevel: "medium",
      authAvailable: true,
      chatDescription: "telegram",
      chatDetail: "\u804a\u5929\u63a5\u5165\u6a21\u5f0f\uff1apolling",
    },
    installerI18n.createInstallerI18n("zh-CN"),
  );
  assert.ok(zhPlan.includes("\u804a\u5929\u63a5\u5165: telegram"));
  assert.ok(zhPlan.includes("\u804a\u5929\u6388\u6743\uff1a"));
  assert.ok(!zhPlan.includes("Chat bridge"));

  const zhSafety = interactive.buildInstallSafetyBoundaryText(
    installerI18n.createInstallerI18n("zh-CN"),
  );
  assert.ok(zhSafety.includes("\u804a\u5929\u63a5\u5165\u89e6\u53d1"));
  assert.ok(!zhSafety.includes("chat-bridge"));

  const initExit = interactive.buildPostInstallInitExitText({
    currentUser: "alice",
    targetUser: "bob",
  });
  assert.ok(initExit.includes("open Rin: rin -u bob"));
  assert.ok(initExit.includes("restart initialization"));

  const launcherPath = "/home/alice/.local/bin/rin";
  const pathMissingInitExit = interactive.buildPostInstallInitExitText({
    currentUser: "alice",
    targetUser: "alice",
    rinPath: launcherPath,
    pathValue: "/usr/bin:/bin",
  });
  assert.ok(pathMissingInitExit.includes(`open Rin: ${launcherPath}`));
  assert.ok(pathMissingInitExit.includes("PATH"));
  assert.ok(pathMissingInitExit.includes("/home/alice/.local/bin"));

  const pathReadyInitExit = interactive.buildPostInstallInitExitText({
    currentUser: "alice",
    targetUser: "alice",
    rinPath: launcherPath,
    pathValue: "/home/alice/.local/bin:/usr/bin:/bin",
  });
  assert.ok(pathReadyInitExit.includes("open Rin: rin"));
  assert.equal(pathReadyInitExit.includes("PATH note"), false);
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

test("promptTargetInstall falls back to all users when no other user exists", async () => {
  const seen = { selects: [] };
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

test("promptInstallerLanguage supports custom BCP 47 tags", async () => {
  const result = await installerI18n.promptInstallerLanguage({
    ensureNotCancelled(value) {
      return value;
    },
    async select() {
      return "custom";
    },
    async text() {
      return "zh-Hans-CN";
    },
  });

  assert.equal(result, "zh-Hans-CN");
});

test("promptInstallerLanguage uses English-only copy for non-Chinese locales", async () => {
  const originalLang = process.env.LANG;
  const originalLcAll = process.env.LC_ALL;
  const originalLcMessages = process.env.LC_MESSAGES;
  process.env.LANG = "en_US.UTF-8";
  delete process.env.LC_ALL;
  delete process.env.LC_MESSAGES;

  try {
    const seen = {};
    const result = await installerI18n.promptInstallerLanguage({
      ensureNotCancelled(value) {
        return value;
      },
      async select(options) {
        seen.select = options;
        return "custom";
      },
      async text(options) {
        seen.text = options;
        return "fr-CA";
      },
    });

    assert.equal(result, "fr-CA");
    assert.equal(seen.select.message, "Choose installer language");
    assert.equal(seen.select.options[0].hint, "en");
    assert.deepEqual(seen.select.options.at(-1), {
      value: "custom",
      label: "Other",
      hint: "Enter any BCP 47 language tag",
    });
    assert.equal(seen.text.message, "Enter language tag (BCP 47)");
    assert.equal(seen.text.placeholder, "en-US");
    assert.equal(seen.text.defaultValue, "en-US");
    assert.equal(
      seen.text.validate("nope nope"),
      "Use a valid BCP 47 language tag",
    );
  } finally {
    if (originalLang == null) delete process.env.LANG;
    else process.env.LANG = originalLang;
    if (originalLcAll == null) delete process.env.LC_ALL;
    else process.env.LC_ALL = originalLcAll;
    if (originalLcMessages == null) delete process.env.LC_MESSAGES;
    else process.env.LC_MESSAGES = originalLcMessages;
  }
});

test("promptInstallerLanguage localizes the picker copy for Chinese locales", async () => {
  const originalLang = process.env.LANG;
  const originalLcAll = process.env.LC_ALL;
  const originalLcMessages = process.env.LC_MESSAGES;
  process.env.LANG = "zh_CN.UTF-8";
  delete process.env.LC_ALL;
  delete process.env.LC_MESSAGES;

  try {
    let selectOptions;
    const result = await installerI18n.promptInstallerLanguage({
      ensureNotCancelled(value) {
        return value;
      },
      async select(options) {
        selectOptions = options;
        return "en";
      },
      async text() {
        throw new Error(
          "text prompt should not run when a preset option is chosen",
        );
      },
    });

    assert.equal(result, "en");
    assert.equal(
      selectOptions.message,
      "\u9009\u62e9\u5b89\u88c5\u5668\u8bed\u8a00",
    );
    assert.equal(
      selectOptions.options.find((option) => option.value === "zh-CN")?.hint,
      "zh-CN \xb7 \u5df2\u68c0\u6d4b",
    );
    assert.equal(selectOptions.options.at(-1)?.label, "\u5176\u4ed6");
    assert.equal(
      selectOptions.options.at(-1)?.hint,
      "\u8f93\u5165\u4efb\u610f BCP 47 \u8bed\u8a00\u6807\u7b7e",
    );
  } finally {
    if (originalLang == null) delete process.env.LANG;
    else process.env.LANG = originalLang;
    if (originalLcAll == null) delete process.env.LC_ALL;
    else process.env.LC_ALL = originalLcAll;
    if (originalLcMessages == null) delete process.env.LC_MESSAGES;
    else process.env.LC_MESSAGES = originalLcMessages;
  }
});

test("createInstallerI18n exposes localized post-install path labels", () => {
  const en = installerI18n.createInstallerI18n("en");
  const zh = installerI18n.createInstallerI18n("zh-CN");

  assert.equal(en.targetInstallDirLabel, "Target install dir");
  assert.equal(en.writtenPathLabel, "Written");
  assert.equal(en.serviceLabelLabel, "label");
  assert.equal(
    zh.targetInstallDirLabel,
    "\u76ee\u6807\u5b89\u88c5\u76ee\u5f55",
  );
  assert.equal(zh.writtenPathLabel, "\u5df2\u5199\u5165");
  assert.equal(zh.serviceLabelLabel, "\u6807\u7b7e");
  assert.equal(zh.confirmActiveLabel, "\u662f");
  assert.equal(zh.confirmInactiveLabel, "\u5426");
});

test("installer i18n source keeps localized copy in one display table", () => {
  const source = readFileSync(
    path.join(rootDir, "src", "core", "rin-install", "i18n.ts"),
    "utf8",
  );
  assert.equal(
    (source.match(/const INSTALLER_DISPLAY_COPY =/g) || []).length,
    1,
  );
  assert.equal(source.includes("const local ="), false);
  assert.equal(source.includes("local({"), false);
  assert.equal(source.includes("Record<InstallerDisplayLanguage, T>"), false);
  assert.equal(source.includes("[key: string]"), false);
  assert.equal(source.includes("zh ?"), false);
  assert.equal(source.includes("if (zh)"), false);
  assert.equal(
    source.includes("buildInstallSafetyBoundaryText() {\n      return ["),
    false,
  );
});

test("update mode reuses installer's language prompt and note renderer", () => {
  const mainSource = readFileSync(
    path.join(rootDir, "src", "core", "rin-install", "main.ts"),
    "utf8",
  );
  const updaterSource = readFileSync(
    path.join(rootDir, "src", "core", "rin-install", "updater.ts"),
    "utf8",
  );

  assert.match(mainSource, /RIN_INSTALL_MODE[\s\S]+promptInstallerLanguage/);
  assert.match(mainSource, /active: i18n\.confirmActiveLabel/);
  assert.match(updaterSource, /renderInstallerNote/);
  assert.match(updaterSource, /wrapInstallerNoteText/);
  assert.match(
    updaterSource,
    /const promptConfirm = deps\.confirm \|\| confirm/,
  );
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
