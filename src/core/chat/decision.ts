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

function normalizeDecisionSessionContext(session: any, identity: any) {
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
    chatKey: composeChatKey(platform, chatId, botId),
  };
}

async function getPrivateLikeGroupMemberCount(
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
  } catch {}
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

export async function isPrivateLikeGroupSession(session: any, trust: string) {
  if (!session?.guildId || trust !== "OWNER") return false;
  const platform = safeString(session?.platform || "").trim();
  const chatId = getChatId(session);
  if (!platform || !chatId) return false;
  const count = await getPrivateLikeGroupMemberCount(session, platform, chatId);
  return Number.isFinite(count) && count > 0 && count <= 2;
}

export async function isEffectivePrivateChatSession(
  session: any,
  identity: any,
) {
  if (directLike(session)) return true;
  const context = normalizeDecisionSessionContext(session, identity);
  return await isPrivateLikeGroupSession(session, context.trust);
}

export async function shouldProcessText(
  session: any,
  elements: any[],
  identity: any,
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

  const context = normalizeDecisionSessionContext(session, identity);
  const chatType = directLike(session) ? "private" : "group";
  const privateLikeGroup =
    chatType === "group" &&
    (await isPrivateLikeGroupSession(session, context.trust));
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
