import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { ensureDir, readJsonFile, writeJsonFile } from "../platform/fs.js";
import { safeString } from "../text-utils.js";

export { ensureDir, readJsonFile, writeJsonFile } from "../platform/fs.js";
export {
  ensureExtension,
  ensureFileName,
  extensionFromMimeType,
  fileNameFromUrl,
} from "./file-utils.js";
export {
  buildChatConfigFromSettings,
  buildChatRuntimePackageJson,
  ensureChatRuntimeDependencies,
  listChatRuntimeAdapterEntries,
  materializeChatConfig,
  shouldInstallChatRuntimeDependencies,
} from "./runtime-config.js";
export type { ChatRuntimeAdapterEntry } from "./runtime-config.js";

export type ParsedChatKey = {
  platform: string;
  botId: string;
  chatId: string;
};

export type ChatType = "private" | "group";

function normalizeChatPlatform(platform: unknown) {
  return safeString(platform).trim();
}

function normalizeChatId(chatId: unknown) {
  return safeString(chatId).trim();
}

function normalizeTrust(value: unknown) {
  const nextTrust = safeString(value).trim().toUpperCase();
  return nextTrust === "OWNER" || nextTrust === "TRUSTED" ? nextTrust : "OTHER";
}

export function inferChatType(target: {
  platform: string;
  chatId: string;
}): ChatType {
  const platform = safeString(target?.platform).trim();
  const chatId = safeString(target?.chatId).trim();
  if (platform === "telegram") {
    return chatId.startsWith("-") ? "group" : "private";
  }
  return chatId.startsWith("private:") ? "private" : "group";
}

export function isPrivateChat(target: { platform: string; chatId: string }) {
  return inferChatType(target) === "private";
}

export function composeChatKey(platform: string, chatId: string, botId = "") {
  const nextPlatform = normalizeChatPlatform(platform);
  const nextChatId = normalizeChatId(chatId);
  const nextBotId = normalizeChatId(botId);
  if (!nextPlatform || !nextBotId || !nextChatId) return "";
  return `${nextPlatform}/${nextBotId}:${nextChatId}`;
}

export function parseChatKey(chatKey: string): ParsedChatKey | null {
  const match = safeString(chatKey)
    .trim()
    .match(/^([^/:]+)\/([^:]+):(.+)$/);
  if (!match) return null;
  const platform = normalizeChatPlatform(match[1]);
  const botId = normalizeChatId(match[2]);
  const chatId = normalizeChatId(match[3]);
  if (!platform || !botId || !chatId) return null;
  return { platform, botId, chatId };
}

export function normalizeChatKey(value: unknown) {
  const parsed = parseChatKey(safeString(value).trim());
  return parsed
    ? composeChatKey(parsed.platform, parsed.chatId, parsed.botId)
    : undefined;
}

export function chatStateDir(dataDir: string, chatKey: string) {
  const parsed = parseChatKey(chatKey);
  if (!parsed) throw new Error(`invalid_chatKey:${chatKey}`);
  return path.join(
    dataDir,
    "chat",
    "session-state",
    parsed.platform,
    parsed.botId,
    parsed.chatId,
  );
}

export function chatStatePath(dataDir: string, chatKey: string) {
  return path.join(chatStateDir(dataDir, chatKey), "state.json");
}

export function listChatStateFiles(chatsRoot: string) {
  const out: Array<{ chatKey: string; statePath: string }> = [];
  try {
    const platforms = fs
      .readdirSync(chatsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const platform of platforms) {
      const platformDir = path.join(chatsRoot, platform);
      const levelOne = fs
        .readdirSync(platformDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      for (const first of levelOne) {
        const firstDir = path.join(platformDir, first);
        const directStatePath = path.join(firstDir, "state.json");
        if (fs.existsSync(directStatePath)) continue;
        const levelTwo = fs
          .readdirSync(firstDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
        for (const chatId of levelTwo) {
          const statePath = path.join(firstDir, chatId, "state.json");
          if (fs.existsSync(statePath))
            out.push({
              chatKey: composeChatKey(platform, chatId, first),
              statePath,
            });
        }
      }
    }
  } catch {}
  return out;
}

export function listDetachedControllerStateFiles(cronTurnsRoot: string) {
  const out: Array<{
    controllerKey: string;
    statePath: string;
    chatKey: string;
  }> = [];
  try {
    const entries = fs
      .readdirSync(cronTurnsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const controllerKey of entries) {
      const statePath = path.join(cronTurnsRoot, controllerKey, "state.json");
      if (!fs.existsSync(statePath)) continue;
      const state = readJsonFile<any>(statePath, {}) || {};
      out.push({
        controllerKey,
        statePath,
        chatKey: safeString(state.chatKey).trim() || `cron:${controllerKey}`,
      });
    }
  } catch {}
  return out;
}

export function identityPath(dataDir: string) {
  return path.join(dataDir, "identity.json");
}

export type ChatTrust = "OWNER" | "TRUSTED" | "OTHER";

export function ensureIdentitySeed(dataDir: string) {
  const filePath = identityPath(dataDir);
  if (fs.existsSync(filePath)) return;
  writeJsonFile(filePath, {
    persons: {},
    aliases: [],
    trusted: [],
  });
}

export function loadIdentity(dataDir: string) {
  ensureIdentitySeed(dataDir);
  const identity = readJsonFile<any>(identityPath(dataDir), {
    persons: {},
    aliases: [],
    trusted: [],
  });
  identity.persons ||= {};
  identity.aliases ||= [];
  identity.trusted ||= [];
  return identity;
}

export function saveIdentity(dataDir: string, identity: any) {
  writeJsonFile(identityPath(dataDir), identity);
}

function trustPersonId(platform: string, userId: string, trust: ChatTrust) {
  const key = `${safeString(platform).trim()}\n${safeString(userId).trim()}\n${safeString(trust).trim()}`;
  const nextTrust = normalizeTrust(trust);
  const prefix =
    nextTrust === "OWNER"
      ? "owner"
      : nextTrust === "TRUSTED"
        ? "trusted"
        : "other";
  return `${prefix}_${createHash("sha1").update(key).digest("hex").slice(0, 10)}`;
}

function findIdentityAlias(identity: any, platform: string, userId: string) {
  return (Array.isArray(identity?.aliases) ? identity.aliases : []).find(
    (entry: any) =>
      entry &&
      safeString(entry.platform).trim() === platform &&
      safeString(entry.userId).trim() === userId,
  );
}

function rebuildTrustedIndex(identity: any) {
  identity.trusted = Object.entries(identity?.persons || {})
    .filter(([, person]: any) => normalizeTrust(person?.trust) === "TRUSTED")
    .map(([id]) => id);
}

export function countOwnerIdentities(identity: any) {
  return (Array.isArray(identity?.aliases) ? identity.aliases : []).filter(
    (entry: any) =>
      normalizeTrust(
        identity?.persons?.[safeString(entry?.personId).trim()]?.trust,
      ) === "OWNER",
  ).length;
}

export function hasOwnerIdentity(identity: any) {
  return countOwnerIdentities(identity) > 0;
}

export function setIdentityTrust(options: {
  dataDir: string;
  platform: string;
  userId: string;
  trust: ChatTrust;
  name?: string;
}) {
  const platform = safeString(options.platform).trim();
  const userId = safeString(options.userId).trim();
  const trust = normalizeTrust(options.trust);
  const name = safeString(options.name).trim();
  if (!platform) throw new Error("identity_platform_required");
  if (!userId) throw new Error("identity_user_id_required");

  const identity = loadIdentity(options.dataDir);
  const aliases = Array.isArray(identity.aliases) ? identity.aliases : [];
  const persons =
    identity.persons && typeof identity.persons === "object"
      ? identity.persons
      : {};
  const aliasIndex = aliases.findIndex(
    (entry: any) =>
      entry &&
      safeString(entry.platform).trim() === platform &&
      safeString(entry.userId).trim() === userId,
  );
  const existingAlias = aliasIndex >= 0 ? aliases[aliasIndex] : undefined;
  const existingPersonId = safeString(existingAlias?.personId).trim();
  const personId = existingPersonId || trustPersonId(platform, userId, trust);
  const existingPerson =
    persons[personId] && typeof persons[personId] === "object"
      ? persons[personId]
      : {};
  persons[personId] = {
    ...existingPerson,
    ...(name ? { name } : {}),
    trust,
  };
  if (aliasIndex >= 0) {
    aliases[aliasIndex] = {
      ...aliases[aliasIndex],
      platform,
      userId,
      personId,
    };
  } else {
    aliases.push({ platform, userId, personId });
  }

  identity.persons = persons;
  identity.aliases = aliases;
  rebuildTrustedIndex(identity);
  saveIdentity(options.dataDir, identity);
  return {
    platform,
    userId,
    trust,
    name: safeString(identity.persons?.[personId]?.name).trim() || undefined,
    personId,
    path: identityPath(options.dataDir),
  };
}

export function updateIdentityTrust(options: {
  dataDir: string;
  actorPlatform: string;
  actorUserId: string;
  actorTrust?: string;
  actorName?: string;
  targetPlatform?: string;
  targetUserId?: string;
  targetName?: string;
  trust: ChatTrust;
}) {
  const identity = loadIdentity(options.dataDir);
  const actorPlatform = safeString(options.actorPlatform).trim();
  const actorUserId = safeString(options.actorUserId).trim();
  const actorTrust = normalizeTrust(
    options.actorTrust || trustOf(identity, actorPlatform, actorUserId),
  );
  const trust = normalizeTrust(options.trust);
  const targetPlatform =
    safeString(options.targetPlatform).trim() || actorPlatform;
  const targetUserId = safeString(options.targetUserId).trim() || actorUserId;
  const targetName =
    safeString(options.targetName).trim() ||
    safeString(options.actorName).trim() ||
    undefined;
  if (!targetPlatform) throw new Error("identity_platform_required");
  if (!targetUserId) throw new Error("identity_user_id_required");

  const ownerExists = hasOwnerIdentity(identity);
  if (!ownerExists) {
    if (trust !== "OWNER") throw new Error("identity_owner_bootstrap_required");
    if (targetPlatform !== actorPlatform || targetUserId !== actorUserId) {
      throw new Error("identity_first_owner_must_self_claim");
    }
  } else if (actorTrust !== "OWNER") {
    throw new Error("identity_owner_required");
  }

  const existingAlias = findIdentityAlias(
    identity,
    targetPlatform,
    targetUserId,
  );
  const existingTrust = normalizeTrust(
    identity?.persons?.[safeString(existingAlias?.personId).trim()]?.trust,
  );
  if (
    existingTrust === "OWNER" &&
    trust !== "OWNER" &&
    countOwnerIdentities(identity) <= 1
  ) {
    throw new Error("identity_last_owner_required");
  }

  const result = setIdentityTrust({
    dataDir: options.dataDir,
    platform: targetPlatform,
    userId: targetUserId,
    trust,
    name: targetName,
  });
  return {
    ...result,
    bootstrap: !ownerExists && trust === "OWNER",
    actorTrust,
  };
}

export function trustOf(identity: any, platform: string, userId: string) {
  const nextPlatform = normalizeChatPlatform(platform);
  const nextUserId = normalizeChatId(userId);
  if (!nextPlatform || !nextUserId) return "OTHER";
  const alias = findIdentityAlias(identity, nextPlatform, nextUserId);
  const personId = safeString(alias?.personId).trim();
  if (!personId) return "OTHER";
  return normalizeTrust(identity?.persons?.[personId]?.trust);
}

export function canAccessAgentInput({
  chatType,
  trust,
  mentionLike = false,
  commandLike = false,
  allowWithoutMention = false,
}: {
  chatType: "private" | "group";
  trust: string;
  mentionLike?: boolean;
  commandLike?: boolean;
  allowWithoutMention?: boolean;
}) {
  const nextTrust = normalizeTrust(trust);
  if (commandLike) return false;
  const trusted = nextTrust === "OWNER" || nextTrust === "TRUSTED";
  if (chatType === "private") return trusted;
  return trusted && (Boolean(mentionLike) || Boolean(allowWithoutMention));
}

export function canRunCommand(trust: string, commandName: string) {
  const nextTrust = normalizeTrust(trust);
  const nextName = safeString(commandName).trim().replace(/^\//, "");
  if (!nextName) return false;
  return nextTrust === "OWNER" || nextTrust === "TRUSTED";
}

export function botsForPlatform(app: any, platform: string) {
  const bots = Array.isArray(app?.bots) ? app.bots : [];
  const nextPlatform = normalizeChatPlatform(platform);
  if (!nextPlatform) return [];
  return bots.filter(
    (bot: any) => normalizeChatPlatform(bot?.platform) === nextPlatform,
  );
}

export function composeChatKeyForBot(
  _app: any,
  platform: string,
  chatId: string,
  botId = "",
) {
  return composeChatKey(platform, chatId, botId);
}

export function findBot(app: any, platform: string, botId = "") {
  const matches = botsForPlatform(app, platform);
  const nextBotId = normalizeChatId(botId);
  if (!matches.length || !nextBotId) return null;
  return (
    matches.find((bot: any) => normalizeChatId(bot?.selfId) === nextBotId) ||
    null
  );
}
