import { canAccessChatInput, composeChatKey, trustOf } from "./support.js";
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

function normalizeTrustForDecision(value: any) {
  const trust = safeString(value).trim().toUpperCase();
  return trust === "OWNER" || trust === "TRUSTED" ? trust : "OTHER";
}

const PRIVATE_LIKE_GROUP_MEMBER_CACHE_TTL_MS = 10 * 60 * 1000;
const privateLikeGroupNegativeCache = new Map<string, { expiresAt: number }>();

type CompleteChatMemberProof =
  | {
      complete: true;
      nonAgentUserIds: string[];
    }
  | {
      complete: true;
      privateLike: false;
    };

type IncompleteChatMemberProof = {
  complete: false;
};

type ChatMemberProof = CompleteChatMemberProof | IncompleteChatMemberProof;

function privateLikeGroupMemberCacheKey(
  context: ReturnType<typeof normalizeDecisionSessionContext>,
) {
  return [context.platform, context.botId, context.chatId].join("\0");
}

function uniqueMemberIds(values: unknown[]) {
  const ids = values.map((value) => safeString(value).trim());
  if (ids.some((id) => !id)) return null;
  return Array.from(new Set(ids));
}

function canonicalDecimalCount(value: unknown) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function listLarkChatMembers(
  internal: any,
  chatId: string,
): Promise<ChatMemberProof> {
  // Lark's chat-members endpoint returns users and explicitly omits bots.
  const nonAgentUserIds: string[] = [];
  const seenPageTokens = new Set<string>();
  let expectedMemberTotal: number | null = null;
  let pageToken = "";
  for (;;) {
    const response = await internal.listChatMembers({
      path: { chat_id: chatId },
      params: {
        member_id_type: "open_id",
        page_size: 100,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });
    if (response?.code !== 0) return { complete: false };
    const data = response?.data;
    if (!data || typeof data !== "object") return { complete: false };
    if (data.trigger_security_conf_limit) return { complete: false };
    if (!("member_total" in data)) return { complete: false };
    const memberTotal = data.member_total;
    if (!Number.isSafeInteger(memberTotal) || memberTotal < 0) {
      return { complete: false };
    }
    if (expectedMemberTotal !== null && expectedMemberTotal !== memberTotal) {
      return { complete: false };
    }
    expectedMemberTotal = memberTotal;
    if (!Array.isArray(data.items)) return { complete: false };
    const pageIds = uniqueMemberIds(
      data.items.map((item: any) => item?.member_id),
    );
    if (!pageIds) return { complete: false };
    nonAgentUserIds.push(...pageIds);
    if (typeof data.has_more !== "boolean") return { complete: false };
    if (!data.has_more) {
      const uniqueNonAgentUserIds = Array.from(new Set(nonAgentUserIds));
      if (
        expectedMemberTotal !== null &&
        uniqueNonAgentUserIds.length !== expectedMemberTotal
      ) {
        return { complete: false };
      }
      const chatResponse = await internal.getChat({
        path: { chat_id: chatId },
      });
      if (chatResponse?.code !== 0) return { complete: false };
      const userCount = canonicalDecimalCount(chatResponse?.data?.user_count);
      const botCount = canonicalDecimalCount(chatResponse?.data?.bot_count);
      if (userCount !== uniqueNonAgentUserIds.length || botCount !== 1) {
        return { complete: false };
      }
      return {
        complete: true,
        nonAgentUserIds: uniqueNonAgentUserIds,
      };
    }
    const rawNextPageToken = data.page_token;
    if (typeof rawNextPageToken !== "string") return { complete: false };
    const nextPageToken = rawNextPageToken.trim();
    if (!nextPageToken || seenPageTokens.has(nextPageToken)) {
      return { complete: false };
    }
    seenPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }
}

function telegramMemberPresence(member: any, expectedUserId: string) {
  if (!member || typeof member !== "object") return null;
  const actualUserId = safeString(member?.user?.id).trim();
  if (!actualUserId || actualUserId !== expectedUserId) return null;
  const status = safeString(member.status).trim().toLowerCase();
  if (["creator", "administrator", "member"].includes(status)) return true;
  if (["left", "kicked", "banned"].includes(status)) return false;
  if (status === "restricted") {
    return typeof member.is_member === "boolean" ? member.is_member : null;
  }
  return null;
}

async function getTelegramChatMemberProof(
  internal: any,
  chatId: string,
  botId: string,
  ownerUserId: string,
): Promise<ChatMemberProof> {
  if (!botId || !ownerUserId || botId === ownerUserId) {
    return { complete: false };
  }
  const memberCount = await internal.getChatMemberCount({ chat_id: chatId });
  if (!Number.isSafeInteger(memberCount) || memberCount < 0) {
    return { complete: false };
  }
  if (memberCount !== 2) return { complete: true, privateLike: false };

  const [ownerMember, agentMember] = await Promise.all([
    internal.getChatMember({ chat_id: chatId, user_id: ownerUserId }),
    internal.getChatMember({ chat_id: chatId, user_id: botId }),
  ]);
  const ownerPresent = telegramMemberPresence(ownerMember, ownerUserId);
  const agentPresent = telegramMemberPresence(agentMember, botId);
  if (ownerPresent === null || agentPresent === null) {
    return { complete: false };
  }
  if (!ownerPresent || !agentPresent) {
    return { complete: true, privateLike: false };
  }
  return { complete: true, nonAgentUserIds: [ownerUserId] };
}

async function listOneBotChatMembers(
  internal: any,
  chatId: string,
  botId: string,
): Promise<ChatMemberProof> {
  if (!botId) return { complete: false };
  const response = await internal.getGroupMemberList(chatId);
  if (!Array.isArray(response)) return { complete: false };
  const memberIds = uniqueMemberIds(
    response.map((member: any) => member?.user_id),
  );
  if (!memberIds || !memberIds.includes(botId)) return { complete: false };
  return {
    complete: true,
    nonAgentUserIds: memberIds.filter((userId) => userId !== botId),
  };
}

async function listSlackChatMembers(
  internal: any,
  chatId: string,
  botId: string,
): Promise<ChatMemberProof> {
  if (!botId) return { complete: false };
  const memberIds: string[] = [];
  const seenCursors = new Set<string>();
  let cursor = "";
  for (;;) {
    const response = await internal.conversationsMembers({
      channel: chatId,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    if (
      !response ||
      response.ok !== true ||
      !Array.isArray(response.members) ||
      !response.response_metadata ||
      typeof response.response_metadata.next_cursor !== "string"
    ) {
      return { complete: false };
    }
    const pageIds = uniqueMemberIds(response.members);
    if (!pageIds) return { complete: false };
    memberIds.push(...pageIds);
    const nextCursor = response.response_metadata.next_cursor.trim();
    if (!nextCursor) break;
    if (seenCursors.has(nextCursor)) return { complete: false };
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  const uniqueIds = Array.from(new Set(memberIds));
  if (!uniqueIds.includes(botId)) return { complete: false };
  return {
    complete: true,
    nonAgentUserIds: uniqueIds.filter((userId) => userId !== botId),
  };
}

async function getCompleteChatMemberProof(
  session: any,
  context: ReturnType<typeof normalizeDecisionSessionContext>,
): Promise<ChatMemberProof> {
  if (!["lark", "onebot", "slack", "telegram"].includes(context.platform)) {
    return { complete: false };
  }
  try {
    const internal = session?.bot?.internal;
    if (
      context.platform === "telegram" &&
      typeof internal?.getChatMemberCount === "function" &&
      typeof internal?.getChatMember === "function"
    ) {
      return await getTelegramChatMemberProof(
        internal,
        context.chatId,
        context.botId,
        pickUserId(session),
      );
    }
    if (
      context.platform === "lark" &&
      typeof internal?.listChatMembers === "function" &&
      typeof internal?.getChat === "function"
    ) {
      return await listLarkChatMembers(internal, context.chatId);
    }
    if (
      context.platform === "onebot" &&
      typeof internal?.getGroupMemberList === "function"
    ) {
      return await listOneBotChatMembers(
        internal,
        context.chatId,
        context.botId,
      );
    }
    if (
      context.platform === "slack" &&
      typeof internal?.conversationsMembers === "function"
    ) {
      return await listSlackChatMembers(
        internal,
        context.chatId,
        context.botId,
      );
    }
  } catch {}
  return { complete: false };
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

async function isOwnerPresentInChatSession(
  session: any,
  identity: any,
  context: ReturnType<typeof normalizeDecisionSessionContext>,
) {
  if (context.trust === "OWNER") return true;
  // A direct chat contains only its sender and the agent. A TRUSTED sender
  // therefore cannot supply the OWNER-presence required by the shared policy.
  if (directLike(session)) return false;
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

export async function isOwnerPresentForChat(session: any, identity: any) {
  return await isOwnerPresentInChatSession(
    session,
    identity,
    normalizeDecisionSessionContext(session, identity),
  );
}

export async function resolveChatInputAccess(
  session: any,
  identity: any,
  options: { addressedToAgent: boolean } = { addressedToAgent: false },
) {
  const context = normalizeDecisionSessionContext(session, identity);
  const ownerPresent = await isOwnerPresentInChatSession(
    session,
    identity,
    context,
  );
  return {
    allow: canAccessChatInput({
      trust: context.trust,
      ownerPresent,
      addressedToAgent: options.addressedToAgent,
    }),
    trust: context.trust,
    ownerPresent,
  };
}

export async function isPrivateLikeGroupSession(
  session: any,
  identity: any,
  context = normalizeDecisionSessionContext(session, identity),
) {
  if (!session?.guildId || context.trust !== "OWNER") return false;
  if (!context.platform || !context.botId || !context.chatId) return false;

  const cacheKey = privateLikeGroupMemberCacheKey(context);
  const now = Date.now();
  const cached = privateLikeGroupNegativeCache.get(cacheKey);
  if (cached?.expiresAt && cached.expiresAt > now) return false;
  if (cached) privateLikeGroupNegativeCache.delete(cacheKey);

  const members = await getCompleteChatMemberProof(session, context);
  if (!members.complete) return false;
  const senderUserId = pickUserId(session);
  const privateLike =
    "privateLike" in members
      ? members.privateLike
      : Boolean(senderUserId) &&
        members.nonAgentUserIds.length === 1 &&
        members.nonAgentUserIds[0] === senderUserId &&
        trustOf(identity, context.platform, senderUserId) === "OWNER";
  // Recheck owner-only chats so a new member revokes bypass immediately.
  if (!privateLike) {
    privateLikeGroupNegativeCache.set(cacheKey, {
      expiresAt: now + PRIVATE_LIKE_GROUP_MEMBER_CACHE_TTL_MS,
    });
  }
  return privateLike;
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
  options: { chatKey?: string; addressedToAgent?: boolean } = {},
) {
  const text = normalizeMessageText(
    renderChatNodesMarkdown(elements, { renderAt: () => "" }),
  );
  const hasMedia = hasMediaElements(elements);
  const isReplyOnlyTrigger =
    Boolean(pickReplyToMessageId(elements)) &&
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
  if (context.trust === "OTHER") {
    return {
      allow: false,
      text,
      chatKey: context.chatKey,
      chatType,
      trust: context.trust,
      requiresMentionToStartTurn: chatType === "group",
    };
  }
  const privateLikeGroup =
    chatType === "group" &&
    (await isPrivateLikeGroupSession(session, identity, context));
  const access = await resolveChatInputAccess(session, identity, {
    addressedToAgent:
      Boolean(options.addressedToAgent) ||
      directLike(session) ||
      mentionLike(session) ||
      privateLikeGroup,
  });

  return {
    allow: access.allow,
    text,
    chatKey: context.chatKey,
    chatType,
    trust: context.trust,
    requiresMentionToStartTurn: chatType === "group" && !privateLikeGroup,
  };
}
