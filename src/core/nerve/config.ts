import path from "node:path";

import { readJsonFileOrDefault } from "../platform/fs.js";

export type NerveConfig = {
  ownerChatKey: string;
};

export function loadNerveConfig(agentDir: string): NerveConfig {
  const settings = readJsonFileOrDefault<Record<string, unknown>>(
    path.join(path.resolve(agentDir), "settings.json"),
    {},
  );
  const nerve =
    settings.nerve && typeof settings.nerve === "object"
      ? (settings.nerve as Record<string, unknown>)
      : {};
  const rawOwnerChatKey = nerve.ownerChatKey;
  if (rawOwnerChatKey === undefined || rawOwnerChatKey === null) {
    return { ownerChatKey: "" };
  }
  if (typeof rawOwnerChatKey !== "string") {
    throw new Error("nerve_owner_chat_key_invalid");
  }
  const ownerChatKey = rawOwnerChatKey;
  if (ownerChatKey && ownerChatKey !== ownerChatKey.trim()) {
    throw new Error("nerve_owner_chat_key_invalid");
  }
  return { ownerChatKey };
}
