import { cloneJson, isJsonRecord } from "../json-utils.js";
import { safeString } from "../text-utils.js";
import { getStoredChatConfigRoot } from "./settings.js";

export type ChatPlatformEntry<Platform extends string = string> = {
  platform: Platform;
  name: string;
  config: Record<string, unknown>;
};

const SETUP_ONLY_PLATFORM_FIELDS = new Set([
  "name",
  "owners",
  "ownerUserIds",
  "botId",
]);

const SINGLE_PLATFORM_CONFIG_KEYS = new Set([
  "name",
  "enabled",
  "endpoint",
  "selfId",
  "token",
  "protocol",
  "slash",
  "owners",
  "ownerUserIds",
  "botId",
]);

function sanitizePlatformName(value: unknown, fallback: string) {
  const raw = safeString(value)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-");
  return raw || fallback;
}

function looksLikeSinglePlatformConfig(value: unknown) {
  if (!isJsonRecord(value)) return false;
  const keys = Object.keys(value);
  if (!keys.length) return true;
  if (keys.some((key) => SINGLE_PLATFORM_CONFIG_KEYS.has(key))) return true;
  return keys.some((key) => !isJsonRecord(value[key]));
}

function rawPlatformEntries(value: unknown, platform: string) {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      isJsonRecord(entry)
        ? [
            {
              name: sanitizePlatformName(
                entry.name,
                `${platform}-${index + 1}`,
              ),
              config: cloneJson(entry),
            },
          ]
        : [],
    );
  }

  if (looksLikeSinglePlatformConfig(value)) {
    return [
      {
        name: sanitizePlatformName(
          isJsonRecord(value) ? value.name : undefined,
          platform,
        ),
        config: isJsonRecord(value) ? cloneJson(value) : {},
      },
    ];
  }

  if (!isJsonRecord(value)) return [];
  return Object.entries(value).flatMap(([name, entry]) =>
    isJsonRecord(entry)
      ? [
          {
            name: sanitizePlatformName(
              entry.name || name,
              safeString(name) || platform,
            ),
            config: cloneJson(entry),
          },
        ]
      : [],
  );
}

export function listChatPlatformEntries<Platform extends string>(
  settings: unknown,
  platform: Platform,
  defaults: Record<string, unknown> = {},
): ChatPlatformEntry<Platform>[] {
  const key = safeString(platform).trim().toLowerCase() as Platform;
  if (!key) return [];
  const value = getStoredChatConfigRoot(settings)[key];
  return rawPlatformEntries(value, key)
    .filter((entry) => entry.config.enabled !== false)
    .map((entry) => {
      const config = { ...defaults, ...entry.config };
      for (const field of SETUP_ONLY_PLATFORM_FIELDS) delete config[field];
      return { platform: key, name: entry.name, config };
    });
}

export function listBuiltInChatPlatformEntries(
  settings: unknown,
): ChatPlatformEntry<"telegram" | "discord">[] {
  return [
    ...listChatPlatformEntries(settings, "telegram", {
      protocol: "polling",
      slash: false,
      request: { timeout: 30000 },
    }),
    ...listChatPlatformEntries(settings, "discord"),
  ];
}
