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

async function getCompleteChatMemberProof(
  session: any,
  context: ReturnType<typeof normalizeDecisionSessionContext>,
): Promise<ChatMemberProof> {
  const getProof = session?.bot?.getCompleteMemberProof;
  if (typeof getProof !== "function") return { complete: false };
  try {
    const proof = await getProof({
      chatId: context.chatId,
      botId: context.botId,
      senderId: pickUserId(session),
    });
    if (proof?.complete !== true) return { complete: false };
    if (proof.privateLike === false) {
      return { complete: true, privateLike: false };
    }
    const nonAgentUserIds = uniqueMemberIds(proof.nonAgentUserIds || []);
    return nonAgentUserIds
      ? { complete: true, nonAgentUserIds }
      : { complete: false };
  } catch {
    return { complete: false };
  }
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

async function isGroupMember(
  session: any,
  _platform: string,
  chatId: string,
  userId: string,
) {
  const isChatMember = session?.bot?.isChatMember;
  if (typeof isChatMember !== "function") return false;
  try {
    return Boolean(await isChatMember(chatId, userId));
  } catch {
    return false;
  }
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
