import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const getChatMessageMod = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat", "get-chat-message.js"),
  ).href
);

test("get_chat_msg contributes the chat reply lookup system guidance", () => {
  const tools: any[] =
    getChatMessageMod.default({
      agentDir: rootDir,
    }).tools || [];

  const getChatMessageTool = tools.find((tool) => tool.name === "get_chat_msg");
  assert.ok(getChatMessageTool);
  assert.deepEqual(getChatMessageTool.promptGuidelines, [
    "If the current chat message metadata contains `reply to message id: <id>`, always call get_chat_msg with that exact message id before answering.",
  ]);
});
