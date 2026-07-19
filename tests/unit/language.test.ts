import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const installerI18n = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "i18n.js"))
    .href
);
const chatBoot = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "boot.js")).href
);

test("installer and updater copy is English-only", () => {
  const i18n = installerI18n.createInstallerI18n();

  assert.equal(i18n.introTitle, "Rin Installer");
  assert.equal(i18n.updaterIntroTitle, "Rin Updater");
  assert.equal(i18n.confirmActiveLabel, "Yes");
  assert.equal(Object.hasOwn(i18n, "language"), false);
  assert.equal(Object.hasOwn(i18n, "displayLanguage"), false);
  assert.equal(Object.hasOwn(i18n, "isChinese"), false);
  assert.doesNotMatch(
    i18n.buildInstallPlanText({
      targetUser: "alice",
      installDir: "/home/alice/.rin",
      provider: "openai",
      modelId: "gpt",
      thinkingLevel: "medium",
      authAvailable: true,
      setDefaultTarget: false,
    }),
    /Language:/,
  );
});

test("installer copy factories keep instances isolated", () => {
  const first = installerI18n.createInstallerI18n();
  const second = installerI18n.createInstallerI18n();

  first.introTitle = "Changed locally";
  first.chatCommandDescriptions.help = "Changed help";
  first.chatRuntime.telegramWorking.prompts[0] = "Changed working frame";
  first.installSafetyBoundaryLines[0] = "Changed boundary";

  assert.equal(second.introTitle, "Rin Installer");
  assert.equal(second.chatCommandDescriptions.help, "Show available commands");
  assert.notEqual(
    second.chatRuntime.telegramWorking.prompts[0],
    "Changed working frame",
  );
  assert.equal(second.installSafetyBoundaryLines[0], "Rin safety boundary:");
});

test("chat command descriptions use the fixed English catalog", () => {
  const rows = chatBoot.getChatCommandRows();
  assert.equal(
    rows.find((row) => row.name === "new")?.description,
    "Start a new session",
  );
});

test("language configuration and CLI localization producers are removed", () => {
  assert.equal(
    fs.existsSync(path.join(rootDir, "src", "core", "language.ts")),
    false,
  );

  const sourceFiles = [
    "src/core/chat/boot.ts",
    "src/core/chat/main.ts",
    "src/core/rin-lib/runtime.ts",
    "src/core/rin-lib/system-prompt-overlay.ts",
    "src/core/rin/shared.ts",
    "src/core/rin-install/apply-plan.ts",
    "src/core/rin-install/finalize.ts",
    "src/core/rin-install/gui.ts",
    "src/core/rin-install/i18n.ts",
    "src/core/rin-install/interactive.ts",
    "src/core/rin-install/main.ts",
    "src/core/rin-install/persist.ts",
    "src/core/rin-install/quick-run.ts",
    "src/core/rin-install/updater.ts",
    "src/core/rin-gui/native-desktop.ts",
  ]
    .map((file) => fs.readFileSync(path.join(rootDir, file), "utf8"))
    .join("\n");

  for (const forbidden of [
    "promptInstallerLanguage",
    "detectLocalLanguageTag",
    "readConfiguredLanguageFromSettings",
    "buildConfiguredLanguageSystemPrompt",
    "readInstalledUpdateLanguage",
    "readUpdateDisplayLanguage",
    '"--language"',
    "setting-language",
    'name="language"',
  ]) {
    assert.equal(sourceFiles.includes(forbidden), false, forbidden);
  }

  const runtimeSource = fs.readFileSync(
    path.join(rootDir, "src", "core", "rin-lib", "runtime.ts"),
    "utf8",
  );
  assert.equal((runtimeSource.match(/Preferred language:/g) || []).length, 1);
  assert.match(runtimeSource, /stripLegacyConfiguredLanguagePrompt/);

  const installerCopy = fs.readFileSync(
    path.join(rootDir, "src", "core", "rin-install", "i18n.ts"),
    "utf8",
  );
  assert.doesNotMatch(installerCopy, /[\u3400-\u9fff]/u);

  const nativeDesktopSource = fs.readFileSync(
    path.join(rootDir, "src", "core", "rin-gui", "native-desktop.ts"),
    "utf8",
  );
  assert.doesNotMatch(nativeDesktopSource, /delete next\.language/);
});
