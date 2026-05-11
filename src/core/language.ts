import fs from "node:fs";
import path from "node:path";

export type InstallerDisplayLanguage = "en" | "zh-CN";

export const DEFAULT_LANGUAGE_TAG = "en-US";

const LANGUAGE_ENV_KEYS = ["LC_ALL", "LC_MESSAGES", "LANG"] as const;

const LANGUAGE_ONLY_DEFAULTS: Record<string, string> = {
  ar: "ar-SA",
  de: "de-DE",
  en: DEFAULT_LANGUAGE_TAG,
  es: "es-ES",
  fr: "fr-FR",
  hi: "hi-IN",
  ja: "ja-JP",
  ko: "ko-KR",
  pt: "pt-BR",
  ru: "ru-RU",
  zh: "zh-CN",
};

function normalizeLanguageInput(value: unknown) {
  return String(value || "")
    .trim()
    .replace(/[.:].*$/, "")
    .replace(/_/g, "-");
}

function expandLanguageOnlyTag(languageTag: string) {
  const normalized = languageTag.toLowerCase();
  return LANGUAGE_ONLY_DEFAULTS[normalized] || languageTag;
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
  return language === "zh" || language.startsWith("zh-");
}

function normalizeLocaleEnvLanguageTag(value: unknown) {
  return canonicalizeLanguageTag(value);
}

export function resolveInstallerDisplayLanguage(
  value: unknown,
): InstallerDisplayLanguage {
  return isChineseLanguageTag(value) ? "zh-CN" : "en";
}

export function detectLocalLanguageTag(fallback = DEFAULT_LANGUAGE_TAG) {
  for (const key of LANGUAGE_ENV_KEYS) {
    const normalized = normalizeLocaleEnvLanguageTag(process.env[key]);
    if (normalized) return normalized;
  }
  return normalizeLanguageTag(fallback);
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
