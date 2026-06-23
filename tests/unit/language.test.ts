import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const language = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "language.js")).href
);

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-language-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("language helpers canonicalize regioned tags to locale codes and reject invalid input", () => {
  assert.equal(language.canonicalizeLanguageTag(" en "), "en_US");
  assert.equal(language.canonicalizeLanguageTag(" en_US.UTF-8 "), "en_US");
  assert.equal(language.canonicalizeLanguageTag(" zh_hans_cn "), "zh_Hans_CN");
  assert.equal(language.canonicalizeLanguageTag(" zh-Hans-cn "), "zh_Hans_CN");
  assert.equal(language.canonicalizeLanguageTag("nope nope"), "");
  assert.equal(language.normalizeLanguageTag("", "en"), "en_US");
});

test("resolveInstallerDisplayLanguage treats all zh locales as Chinese", () => {
  assert.equal(language.resolveInstallerDisplayLanguage("zh"), "zh_CN");
  assert.equal(language.resolveInstallerDisplayLanguage("zh_TW"), "zh_CN");
  assert.equal(language.resolveInstallerDisplayLanguage("zh-Hans-CN"), "zh_CN");
  assert.equal(language.resolveInstallerDisplayLanguage("ja"), "en_US");
  assert.equal(language.resolveInstallerDisplayLanguage("nope nope"), "en_US");
});

test("detectLocalLanguageTag uses Windows UI culture when locale env is absent", () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const detected = language.detectLocalLanguageTag("en", {
    platform: "win32",
    env: {},
    execFileSync(command: string, args: string[]) {
      calls.push({ command, args });
      return "zh-CN\r\n";
    },
  });

  assert.equal(detected, "zh_CN");
  assert.equal(calls[0]?.command, "powershell.exe");
  assert.ok(
    calls[0]?.args.some((arg) => String(arg).includes("CurrentUICulture")),
  );
});

test("detectLocalLanguageTag falls back to Intl locale when native Windows probe fails", () => {
  const detected = language.detectLocalLanguageTag("en", {
    platform: "win32",
    env: {},
    intlLocale: "zh-Hant-TW",
    execFileSync() {
      throw new Error("missing powershell");
    },
  });

  assert.equal(detected, "zh_Hant_TW");
});

test("detectLocalLanguageTag prefers LC_ALL then LC_MESSAGES then LANG", () => {
  const originalLang = process.env.LANG;
  const originalLcAll = process.env.LC_ALL;
  const originalLcMessages = process.env.LC_MESSAGES;

  try {
    process.env.LANG = "fr_CA.UTF-8";
    process.env.LC_MESSAGES = "zh_CN.UTF-8:zh";
    process.env.LC_ALL = "ja_JP.UTF-8";
    assert.equal(language.detectLocalLanguageTag("en"), "ja_JP");

    process.env.LC_ALL = "bad tag";
    assert.equal(language.detectLocalLanguageTag("en"), "zh_CN");

    delete process.env.LC_ALL;
    assert.equal(language.detectLocalLanguageTag("en"), "zh_CN");

    delete process.env.LC_MESSAGES;
    assert.equal(language.detectLocalLanguageTag("en"), "fr_CA");

    process.env.LANG = "bad tag";
    assert.equal(language.detectLocalLanguageTag("en"), "en_US");
  } finally {
    if (originalLang == null) delete process.env.LANG;
    else process.env.LANG = originalLang;
    if (originalLcAll == null) delete process.env.LC_ALL;
    else process.env.LC_ALL = originalLcAll;
    if (originalLcMessages == null) delete process.env.LC_MESSAGES;
    else process.env.LC_MESSAGES = originalLcMessages;
  }
});

test("configured language helpers read settings and build prompt text", async () => {
  await withTempDir(async (agentDir) => {
    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ language: " zh-Hans-CN " }),
    );
    assert.equal(
      language.readConfiguredLanguageFromSettings(agentDir),
      "zh_Hans_CN",
    );
    assert.equal(
      language.buildConfiguredLanguageSystemPrompt(" zh-Hans-CN "),
      [
        "Configured runtime defaults:",
        "- Preferred language: zh_Hans_CN",
        "- Unless the user explicitly asks otherwise, default to this language for replies, onboarding, and other user-facing text.",
      ].join("\n"),
    );

    await fs.writeFile(path.join(agentDir, "settings.json"), "not json");
    assert.equal(language.readConfiguredLanguageFromSettings(agentDir), "");
    assert.equal(language.buildConfiguredLanguageSystemPrompt("nope nope"), "");
  });
});
