import { execFileSync as defaultExecFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type InstallerDisplayLanguage = "en_US" | "zh_CN";

export const DEFAULT_LANGUAGE_TAG = "en_US";

const LANGUAGE_ENV_KEYS = ["LC_ALL", "LC_MESSAGES", "LANG"] as const;
const WINDOWS_LANGUAGE_COMMANDS: ReadonlyArray<{
  command: string;
  args: string[];
}> = [
  {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[System.Globalization.CultureInfo]::CurrentUICulture.Name",
    ],
  },
  {
    command: "pwsh.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[System.Globalization.CultureInfo]::CurrentUICulture.Name",
    ],
  },
];

export type LocalLanguageDetectionOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  intlLocale?: string;
  execFileSync?: typeof defaultExecFileSync;
};

const LANGUAGE_ONLY_DEFAULTS: Record<string, string> = {
  ar: "ar_SA",
  de: "de_DE",
  en: DEFAULT_LANGUAGE_TAG,
  es: "es_ES",
  fr: "fr_FR",
  hi: "hi_IN",
  ja: "ja_JP",
  ko: "ko_KR",
  pt: "pt_BR",
  ru: "ru_RU",
  zh: "zh_CN",
};

function normalizeLanguageInput(value: unknown) {
  return String(value || "")
    .trim()
    .replace(/[.:].*$/, "")
    .replace(/_/g, "-");
}

function toLocaleCode(languageTag: string) {
  return languageTag.replace(/-/g, "_");
}

function expandLanguageOnlyTag(languageTag: string) {
  const normalized = languageTag.toLowerCase();
  return LANGUAGE_ONLY_DEFAULTS[normalized] || toLocaleCode(languageTag);
}

export function canonicalizeLanguageTag(value: unknown) {
  const text = normalizeLanguageInput(value);
  if (!text) return "";
  try {
    return expandLanguageOnlyTag(Intl.getCanonicalLocales(text)[0] || "");
  } catch {
    return "";
  }
}

export function normalizeLanguageTag(
  value: unknown,
  fallback = DEFAULT_LANGUAGE_TAG,
) {
  return canonicalizeLanguageTag(value) || canonicalizeLanguageTag(fallback);
}

function isChineseLanguageTag(value: unknown) {
  const language = normalizeLanguageTag(value, "").toLowerCase();
  return language === "zh" || language.startsWith("zh_");
}

function normalizeLocaleEnvLanguageTag(value: unknown) {
  return canonicalizeLanguageTag(value);
}

export function resolveInstallerDisplayLanguage(
  value: unknown,
): InstallerDisplayLanguage {
  return isChineseLanguageTag(value) ? "zh_CN" : "en_US";
}

function detectIntlDefaultLanguageTag(options: LocalLanguageDetectionOptions) {
  const explicit = normalizeLocaleEnvLanguageTag(options.intlLocale);
  if (explicit) return explicit;
  try {
    return normalizeLocaleEnvLanguageTag(
      Intl.DateTimeFormat().resolvedOptions().locale,
    );
  } catch {
    return "";
  }
}

function detectWindowsLanguageTag(options: LocalLanguageDetectionOptions) {
  if ((options.platform || process.platform) !== "win32") return "";
  const execFileSync = options.execFileSync || defaultExecFileSync;
  for (const probe of WINDOWS_LANGUAGE_COMMANDS) {
    try {
      const output = execFileSync(probe.command, probe.args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
        windowsHide: true,
      });
      const normalized = normalizeLocaleEnvLanguageTag(output);
      if (normalized) return normalized;
    } catch {}
  }
  return "";
}

export function detectLocalLanguageTag(
  fallback = DEFAULT_LANGUAGE_TAG,
  options: LocalLanguageDetectionOptions = {},
) {
  const env = options.env || process.env;
  let sawLocaleEnv = false;
  for (const key of LANGUAGE_ENV_KEYS) {
    const raw = String(env[key] || "").trim();
    sawLocaleEnv ||= Boolean(raw);
    const normalized = normalizeLocaleEnvLanguageTag(raw);
    if (normalized) return normalized;
  }
  if (sawLocaleEnv) return normalizeLanguageTag(fallback);
  return (
    detectWindowsLanguageTag(options) ||
    detectIntlDefaultLanguageTag(options) ||
    normalizeLanguageTag(fallback)
  );
}

export function readConfiguredLanguageFromSettings(agentDir: string) {
  const settingsPath = path.join(agentDir, "settings.json");
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      language?: string;
    };
    return canonicalizeLanguageTag(settings?.language);
  } catch {
    return "";
  }
}

export function buildConfiguredLanguageSystemPrompt(languageTag: string) {
  const normalized = canonicalizeLanguageTag(languageTag);
  if (!normalized) return "";
  return [
    "Configured runtime defaults:",
    `- Preferred language: ${normalized}`,
    "- Unless the user explicitly asks otherwise, default to this language for replies, onboarding, and other user-facing text.",
  ].join("\n");
}
