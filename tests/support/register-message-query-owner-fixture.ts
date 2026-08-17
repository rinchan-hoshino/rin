import "./require-test-sandbox.ts";
import { register } from "node:module";

const replacement = `data:text/javascript,${encodeURIComponent(`
export function getChatMessage(agentDir, chatKey, messageId) {
  globalThis.__rinMessageQueryOwnerCalls.push(["get", agentDir, chatKey, messageId]);
  return globalThis.__rinMessageQueryOwnerRecord;
}
export function listChatMessagesByChatWindow(agentDir, window) {
  globalThis.__rinMessageQueryOwnerCalls.push(["list", agentDir, window]);
  return globalThis.__rinMessageQueryOwnerRecords || [];
}
`)}`;
const hook = `
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.includes("dist/core/chat/message-store.js")) {
    return { url: ${JSON.stringify(replacement)}, shortCircuit: true };
  }
  return resolved;
}
`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);
(globalThis as any).__rinMessageQueryOwnerCalls ||= [];
