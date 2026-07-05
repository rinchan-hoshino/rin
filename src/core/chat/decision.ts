import { canAccessAgentInput, composeChatKey, trustOf } from "./support.js";
import {
  directLike,
  getChatId,
  hasMediaElements,
  mentionLike,
  pickReplyToMessageId,
  pickUserId,
  safeString,
} from "./chat-helpers.js";
import { renderChatNodesMarkdown } from "./rich-text.js";
import { normalizeMessageText } from "../message-content.js";

function normalizeDecisionSessionContext(
  session: any,
  identity: any,
  options: { chatKey?: string } = {},
) {
  const platform = safeString(session?.platform || "").trim();
  const chatId = getChatId(session);
  const botId = safeString(
    session?.selfId || session?.bot?.selfId || "",
  ).trim();
  const trust = trustOf(identity, platform, pickUserId(session));
  return {
    platform,
    chatId,
    botId,
    trust,
    chatKey:
      safeString(options.chatKey).trim() ||
      composeChatKey(platform, chatId, botId),
  };
}

function ownerUserIdsForPlatform(identity: any, platform: string) {
  const aliases = ownerAliasesForPlatform(identity, platform);
  return Array.from(
    new Set(
      aliases
        .map((alias: any) => safeString(alias?.userId).trim())
        .filter(Boolean),
    ),
  );
}

async function adapterConfirmsOnlyOwnerUsers(
  session: any,
  identity: any,
  context: ReturnType<typeof normalizeDecisionSessionContext>,
) {
  if (context.trust !== "OWNER") return false;
  if (!context.platform || !context.chatId) return false;
  const ownerUserIds = ownerUserIdsForPlatform(identity, context.platform);
  const senderUserId = pickUserId(session);
  if (senderUserId && !ownerUserIds.includes(senderUserId)) {
    ownerUserIds.push(senderUserId);
  }
  if (!ownerUserIds.length) return false;
  const checker = session?.bot?.hasOnlyOwnerUsers;
  if (typeof checker !== "function") return false;
  try {
    return Boolean(
      await checker.call(session.bot, context.chatId, ownerUserIds, {
        platform: context.platform,
        botId: context.botId,
        session,
      }),
    );
  } catch {}
  return false;
}

const PRIVATE_LIKE_GROUP_MEMBER_COUNT_CACHE_TTL_MS = 10 * 60 * 1000;
const GROUP_MEMBER_MISSING_CACHE_TTL_MS = 10 * 60 * 1000;
const privateLikeGroupMemberCountCache = new Map<
  string,
  { value: number; expiresAt: number }
>();
const groupMemberMissingCache = new Map<string, number>();

function privateLikeGroupMemberCountCacheKey(
  session: any,
  platform: string,
  chatId: string,
) {
  const botId = safeString(
    session?.selfId || session?.bot?.selfId || "",
  ).trim();
  return [platform, botId, chatId].map((part) => safeString(part)).join("\0");
}

function hasPrivateLikeGroupMemberCountProvider(
  session: any,
  platform: string,
) {
  const internal = session?.bot?.internal;
  return (
    typeof session?.bot?.getGuildMemberCount === "function" ||
    (platform === "telegram" &&
      typeof internal?.getChatMemberCount === "function") ||
    (platform === "onebot" && typeof internal?.getGroupInfo === "function") ||
    (platform === "lark" && typeof internal?.getChat === "function")
  );
}

async function fetchPrivateLikeGroupMemberCount(
  session: any,
  platform: string,
  chatId: string,
) {
  const internal = session?.bot?.internal;
  try {
    if (typeof session?.bot?.getGuildMemberCount === "function") {
      return Number(await session.bot.getGuildMemberCount(chatId));
    }
    if (
      platform === "telegram" &&
      typeof internal?.getChatMemberCount === "function"
    ) {
      return Number(await internal.getChatMemberCount({ chat_id: chatId }));
    }
    if (platform === "onebot" && typeof internal?.getGroupInfo === "function") {
      const info = await internal.getGroupInfo(chatId, true);
      return Number(info?.member_count ?? info?.memberCount ?? 0);
    }
    if (platform === "lark" && typeof internal?.getChat === "function") {
      const response = await internal.getChat({
        path: { chat_id: chatId },
        params: { user_id_type: "open_id" },
      });
      const data =
        response?.data && typeof response.data === "object"
          ? response.data
          : response && typeof response === "object"
            ? response
            : {};
      const userCount = Number(data?.user_count ?? data?.userCount ?? 0);
      const botCount = Number(data?.bot_count ?? data?.botCount ?? 1);
      if (Number.isFinite(userCount) && userCount > 0) {
        return userCount + (Number.isFinite(botCount) ? botCount : 1);
      }
    }
  } catch {}
  return 0;
}

async function getPrivateLikeGroupMemberCount(
  session: any,
  platform: string,
  chatId: string,
) {
  if (!hasPrivateLikeGroupMemberCountProvider(session, platform)) return 0;

  const key = privateLikeGroupMemberCountCacheKey(session, platform, chatId);
  const now = Date.now();
  const cached = privateLikeGroupMemberCountCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  if (cached) privateLikeGroupMemberCountCache.delete(key);

  const value = Number(
    await fetchPrivateLikeGroupMemberCount(session, platform, chatId),
  );
  if (Number.isFinite(value) && value > 0) {
    privateLikeGroupMemberCountCache.set(key, {
      value,
      expiresAt: now + PRIVATE_LIKE_GROUP_MEMBER_COUNT_CACHE_TTL_MS,
    });
  }
  return value;
}

function normalizeTrustForDecision(value: any) {
  const trust = safeString(value).trim().toUpperCase();
  return trust === "OWNER" || trust === "TRUSTED" ? trust : "OTHER";
}

function ownerAliasesForPlatform(identity: any, platform: string) {
  const aliases = Array.isArray(identity?.aliases) ? identity.aliases : [];
  return aliases.filter((entry: any) => {
    const personId = safeString(entry?.personId).trim();
    return (
      safeString(entry?.platform).trim() === platform &&
      safeString(entry?.userId).trim() &&
      normalizeTrustForDecision(identity?.persons?.[personId]?.trust) ===
        "OWNER"
    );
  });
}

function isPresentMemberRecord(member: any) {
  if (!member || typeof member !== "object") return false;
  const status = safeString(
    member.status || member.role || member.memberStatus || "",
  )
    .trim()
    .toLowerCase();
  if (["left", "kicked", "banned"].includes(status)) return false;
  if (status === "restricted" && "is_member" in member) {
    return Boolean(member.is_member);
  }
  if (status) {
    return [
      "creator",
      "administrator",
      "member",
      "restricted",
      "owner",
    ].includes(status);
  }
  return Boolean(
    member.user ||
    member.user_id ||
    member.userId ||
    member.memberId ||
    member.id ||
    member.card ||
    member.nickname,
  );
}

async function isGroupMember(
  session: any,
  platform: string,
  chatId: string,
  userId: string,
) {
  const internal = session?.bot?.internal;
  const cacheKey = [
    platform,
    safeString(session?.selfId || session?.bot?.selfId || "").trim(),
    chatId,
    userId,
  ]
    .map((part) => safeString(part))
    .join("\0");
  const cachedMissing = groupMemberMissingCache.get(cacheKey);
  const now = Date.now();
  if (cachedMissing && cachedMissing > now) return false;
  if (cachedMissing) groupMemberMissingCache.delete(cacheKey);
  try {
    if (
      platform === "telegram" &&
      typeof internal?.getChatMember === "function"
    ) {
      return isPresentMemberRecord(
        await internal.getChatMember({ chat_id: chatId, user_id: userId }),
      );
    }
    if (
      platform === "onebot" &&
      typeof internal?.getGroupMemberInfo === "function"
    ) {
      return isPresentMemberRecord(
        await internal.getGroupMemberInfo(chatId, userId, true),
      );
    }
    if (typeof session?.bot?.getGuildMember === "function") {
      return isPresentMemberRecord(
        await session.bot.getGuildMember(chatId, userId),
      );
    }
  } catch {
    groupMemberMissingCache.set(
      cacheKey,
      now + GROUP_MEMBER_MISSING_CACHE_TTL_MS,
    );
  }
  return false;
}

async function isOwnerPresentInGroupSession(
  session: any,
  identity: any,
  context: ReturnType<typeof normalizeDecisionSessionContext>,
) {
  if (context.trust === "OWNER") return true;
  if (!context.platform || !context.chatId) return false;
  const aliases = ownerAliasesForPlatform(identity, context.platform);
  for (const alias of aliases) {
    const userId = safeString(alias?.userId).trim();
    if (!userId) continue;
    if (
      await isGroupMember(session, context.platform, context.chatId, userId)
    ) {
      return true;
    }
  }
  return false;
}

export async function isOwnerPresentForGroup(session: any, identity: any) {
  return await isOwnerPresentInGroupSession(
    session,
    identity,
    normalizeDecisionSessionContext(session, identity),
  );
}

export async function isPrivateLikeGroupSession(
  session: any,
  identity: any,
  context = normalizeDecisionSessionContext(session, identity),
) {
  if (!session?.guildId || context.trust !== "OWNER") return false;
  const platform = context.platform;
  const chatId = context.chatId;
  if (!platform || !chatId) return false;
  if (await adapterConfirmsOnlyOwnerUsers(session, identity, context)) {
    return true;
  }
  const count = await getPrivateLikeGroupMemberCount(session, platform, chatId);
  return Number.isFinite(count) && count > 0 && count <= 2;
}

export async function isEffectivePrivateChatSession(
  session: any,
  identity: any,
) {
  if (directLike(session)) return true;
  const context = normalizeDecisionSessionContext(session, identity);
  return await isPrivateLikeGroupSession(session, identity, context);
}

export async function shouldProcessText(
  session: any,
  elements: any[],
  identity: any,
  options: { chatKey?: string } = {},
) {
  const text = normalizeMessageText(
    renderChatNodesMarkdown(elements, { renderAt: () => "" }),
  );
  const hasMedia = hasMediaElements(elements);
  const isReplyOnlyTrigger =
    Boolean(pickReplyToMessageId(session)) &&
    (directLike(session) || mentionLike(session));
  if (!text && !hasMedia && !isReplyOnlyTrigger)
    return {
      allow: false,
      text: "",
      chatKey: "",
      chatType: "group" as const,
      trust: "OTHER",
      requiresMentionToStartTurn: false,
    };

  const context = normalizeDecisionSessionContext(session, identity, options);
  const chatType = directLike(session) ? "private" : "group";
  const privateLikeGroup =
    chatType === "group" &&
    (await isPrivateLikeGroupSession(session, identity, context));
  if (
    chatType === "group" &&
    !privateLikeGroup &&
    context.trust === "OTHER" &&
    !mentionLike(session)
  ) {
    return {
      allow: false,
      text,
      chatKey: context.chatKey,
      chatType,
      trust: context.trust,
      requiresMentionToStartTurn: true,
    };
  }
  const ownerPresent =
    chatType === "private" ||
    (await isOwnerPresentInGroupSession(session, identity, context));
  const allow =
    ownerPresent &&
    canAccessAgentInput({
      chatType,
      trust: context.trust,
      mentionLike: mentionLike(session),
      commandLike: false,
      allowWithoutMention: privateLikeGroup,
    });

  return {
    allow,
    text,
    chatKey: context.chatKey,
    chatType,
    trust: context.trust,
    requiresMentionToStartTurn: chatType === "group" && !privateLikeGroup,
  };
}
