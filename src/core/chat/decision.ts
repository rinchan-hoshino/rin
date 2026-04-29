import { canAccessAgentInput, composeChatKey, trustOf } from "./support.js";
import {
  directLike,
  getChatId,
  hasMediaElements,
  mentionLike,
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
  } catch {}
  return 0;
}

export async function isPrivateLikeGroupSession(session: any, trust: string) {
  if (!session?.guildId || trust !== "OWNER") return false;
  const platform = safeString(session?.platform || "").trim();
  const chatId = getChatId(session);
  if (!platform || !chatId) return false;
  const count = await getPrivateLikeGroupMemberCount(session, platform, chatId);
  return Number.isFinite(count) && count > 0 && count <= 2;
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
  if (!text && !hasMedia)
    return {
      allow: false,
      text: "",
      chatKey: "",
      trust: "OTHER",
    };

  const context = normalizeDecisionSessionContext(session, identity);
  const privateLike =
    directLike(session) ||
    (await isPrivateLikeGroupSession(session, context.trust));
  const allow = canAccessAgentInput({
    chatType: privateLike ? "private" : "group",
    trust: context.trust,
    mentionLike: mentionLike(session),
    commandLike: false,
  });

  return { allow, text, chatKey: context.chatKey, trust: context.trust };
}
