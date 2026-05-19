import fs from "node:fs";
import path from "node:path";

import { isJsonRecord } from "./json-utils.js";
import { safeString } from "./text-utils.js";

export { createRinI18n } from "./rin-install/i18n.js";

export type RinI18nCatalog = Record<string, string>;

export function rinI18nPath(agentDir: string) {
  return path.join(String(agentDir || "").trim(), "i18n.json");
}

function collectRinI18nCatalog(
  configured: unknown,
  prefix: string,
  output: RinI18nCatalog,
) {
  if (!isJsonRecord(configured)) return;
  for (const [rawKey, rawValue] of Object.entries(configured)) {
    const key = safeString(rawKey).trim();
    if (!key) continue;
    const messageId = prefix ? `${prefix}.${key}` : key;
    if (typeof rawValue === "string") {
      if (rawValue.trim()) output[messageId] = rawValue;
      continue;
    }
    collectRinI18nCatalog(rawValue, messageId, output);
  }
}

export function resolveRinI18nCatalog(configured?: unknown): RinI18nCatalog {
  const catalog: RinI18nCatalog = {};
  collectRinI18nCatalog(configured, "", catalog);
  return catalog;
}

export function readRinI18nCatalog(agentDir: string): RinI18nCatalog {
  const root = String(agentDir || "").trim();
  if (!root) return {};
  try {
    return resolveRinI18nCatalog(
      JSON.parse(fs.readFileSync(rinI18nPath(root), "utf8")),
    );
  } catch {
    return {};
  }
}
