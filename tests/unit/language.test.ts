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

test("language helpers canonicalize regioned tags and reject invalid input", () => {
  assert.equal(language.canonicalizeLanguageTag(" en "), "en-US");
  assert.equal(language.canonicalizeLanguageTag(" en_US.UTF-8 "), "en-US");
  assert.equal(language.canonicalizeLanguageTag(" zh_hans_cn "), "zh-Hans-CN");
  assert.equal(language.canonicalizeLanguageTag(" zh-Hans-cn "), "zh-Hans-CN");
  assert.equal(language.canonicalizeLanguageTag("nope nope"), "");
  assert.equal(language.normalizeLanguageTag("", "en"), "en-US");
});

test("resolveInstallerDisplayLanguage treats all zh locales as Chinese", () => {
  assert.equal(language.resolveInstallerDisplayLanguage("zh"), "zh-CN");
  assert.equal(language.resolveInstallerDisplayLanguage("zh-TW"), "zh-CN");
  assert.equal(language.resolveInstallerDisplayLanguage("zh-Hans-CN"), "zh-CN");
  assert.equal(language.resolveInstallerDisplayLanguage("ja"), "en");
  assert.equal(language.resolveInstallerDisplayLanguage("nope nope"), "en");
});

test("detectLocalLanguageTag prefers LC_ALL then LC_MESSAGES then LANG", () => {
  const originalLang = process.env.LANG;
  const originalLcAll = process.env.LC_ALL;
  const originalLcMessages = process.env.LC_MESSAGES;

  try {
    process.env.LANG = "fr_CA.UTF-8";
    process.env.LC_MESSAGES = "zh_CN.UTF-8:zh";
    process.env.LC_ALL = "ja_JP.UTF-8";
    assert.equal(language.detectLocalLanguageTag("en"), "ja-JP");

    delete process.env.LC_ALL;
    assert.equal(language.detectLocalLanguageTag("en"), "zh-CN");

    delete process.env.LC_MESSAGES;
    assert.equal(language.detectLocalLanguageTag("en"), "fr-CA");

    process.env.LANG = "bad tag";
    assert.equal(language.detectLocalLanguageTag("en"), "en-US");
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
      "zh-Hans-CN",
    );
    assert.equal(
      language.buildConfiguredLanguageSystemPrompt(" zh-Hans-CN "),
      [
        "Configured runtime defaults:",
        "- Preferred language: zh-Hans-CN",
        "- Unless the user explicitly asks otherwise, default to this language for replies, onboarding, and other user-facing text.",
      ].join("\n"),
    );

    await fs.writeFile(path.join(agentDir, "settings.json"), "not json");
    assert.equal(language.readConfiguredLanguageFromSettings(agentDir), "");
    assert.equal(language.buildConfiguredLanguageSystemPrompt("nope nope"), "");
  });
});
