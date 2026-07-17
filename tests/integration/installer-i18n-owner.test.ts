import assert from "node:assert/strict";
import test from "node:test";

import {
  createInstallerI18n,
  createRinI18n,
  promptInstallerLanguage,
} from "../../dist/core/rin-install/i18n.js";

const samplePlan = {
  currentUser: "alice",
  targetUser: "rin",
  installDir: "/srv/rin",
  provider: "openai",
  modelId: "gpt-owner",
  thinkingLevel: "medium",
  authAvailable: true,
  language: "en_US",
  setDefaultTarget: true,
  source: "launcher",
  ownerHome: "/home/rin",
  sourceLabel: "stable 1.2.3",
  writtenPaths: ["/srv/rin/settings.json"],
  prunedReleaseCount: 2,
  serviceKind: "systemd",
  serviceLabel: "rin-daemon.service",
  serviceHint:
    "A Linux user service will be installed and started for this daemon when supported.",
  daemonReady: true,
  userSuffix: " for rin",
  rinCommand: "rin",
  launcherDir: "/home/rin/.local/bin",
  launcherDirOnPath: false,
  installServiceNow: true,
  needsElevatedWrite: true,
  needsElevatedService: true,
};

const functionArguments: Record<string, unknown[]> = {
  existingDirectoryText: ["/srv/rin", 3, ["settings.json", "data"]],
  buildInstallPlanText: [samplePlan],
  buildUpdateTargetText: [samplePlan],
  buildUpdatePlanText: [samplePlan],
  buildUpdateAlreadyCurrentText: [samplePlan],
  buildUpdatedTargetText: [samplePlan],
  buildAfterUpdateText: [samplePlan],
  buildPostInstallInitExitText: [samplePlan],
  buildFinalRequirements: [samplePlan],
  finalizeInstallationMessage: [["requirement one", "requirement two"]],
  noEligibleUsersText: ["alice", ["alice", "rin"]],
  ownershipMismatchText: [
    { statUid: 1000, statGid: 1000, targetUid: 1001, targetGid: 1001 },
  ],
  outroInstalled: ["rin", "systemd", samplePlan],
  updaterOutroUpdated: ["rin", "/srv/rin", true, " for rin"],
  openUrlToContinueLogin: ["https://login.example", "Continue"],
};

function exerciseCopy(languageTag: string) {
  const copy = createInstallerI18n(languageTag) as Record<string, unknown>;
  const called: string[] = [];
  for (const [name, value] of Object.entries(copy)) {
    if (typeof value !== "function") continue;
    const args = functionArguments[name] ?? ["owner", "detail", true, "tail"];
    const result = Reflect.apply(value, copy, args);
    assert.ok(
      typeof result === "string" || Array.isArray(result),
      `${languageTag}:${name}`,
    );
    if (typeof result === "string") assert.ok(result.length > 0, name);
    called.push(name);
  }
  assert.equal(called.length, 34);
  return copy;
}

test("installer copy exposes complete callable English and Chinese contracts", () => {
  const english = exerciseCopy("en_US");
  const chinese = exerciseCopy("zh_CN");
  assert.equal(english.displayLanguage, "en_US");
  assert.equal(english.isChinese, false);
  assert.equal(chinese.displayLanguage, "zh_CN");
  assert.equal(chinese.isChinese, true);
  assert.notEqual(english.introTitle, chinese.introTitle);

  const fallback = createRinI18n("fr_FR");
  assert.equal(fallback.language, "fr_FR");
  assert.equal(fallback.displayLanguage, "en_US");
});

test("installer copy covers optional plan, update, login, and launcher branches", () => {
  for (const locale of ["en_US", "zh_CN"] as const) {
    const copy = createInstallerI18n(locale);
    assert.ok(
      copy.buildFinalRequirements({
        installServiceNow: false,
        needsElevatedWrite: false,
        needsElevatedService: false,
      }).length > 0,
    );
    assert.match(copy.modelCountLabel(1), /1/);
    assert.ok(copy.existingDirectoryText("/srv/rin", 0, []).length > 0);
    assert.ok(
      copy
        .buildInstallPlanText({
          ...samplePlan,
          provider: "",
          modelId: "",
          thinkingLevel: "",
          authAvailable: false,
          setDefaultTarget: false,
        })
        .includes("/srv/rin"),
    );
    assert.ok(
      copy
        .buildUpdatedTargetText({
          installDir: "/srv/rin",
          writtenPaths: [],
          prunedReleaseCount: 0,
        })
        .includes("/srv/rin"),
    );
    assert.ok(
      copy.buildAfterUpdateText({
        serviceHint: "",
        daemonReady: false,
        userSuffix: "",
      }).length > 0,
    );
    assert.ok(
      copy.outroInstalled("rin", undefined, {
        openCommand: "rin",
        immediateCommand: "~/.local/bin/rin",
        launcherDir: "~/.local/bin",
        launcherDirOnPath: false,
      }).length > 0,
    );
    assert.ok(copy.openUrlToContinueLogin("https://login.example").length > 0);
    assert.ok(copy.manualCodePlaceholder("").length > 0);
  }
});

test("language prompt returns a selected locale and validates custom locale input", async () => {
  const selected = await promptInstallerLanguage({
    ensureNotCancelled: (value) => value as string,
    select: async (options) => {
      assert.ok(options.options.some((entry: any) => entry.value === "zh_CN"));
      return "zh_CN";
    },
    text: async () => "unused",
  });
  assert.equal(selected, "zh_CN");

  let blankValidation: string | undefined;
  const custom = await promptInstallerLanguage({
    ensureNotCancelled: (value) => value as string,
    select: async () => "custom",
    text: async (options) => {
      blankValidation = options.validate("not a locale!");
      assert.equal(options.validate("pt-BR"), undefined);
      return "pt-BR";
    },
  });
  assert.equal(custom, "pt_BR");
  assert.ok(blankValidation);
});
