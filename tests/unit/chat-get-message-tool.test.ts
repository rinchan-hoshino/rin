import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const chatModule = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "index.js")).href
);

test("chat message and log helpers are documentation-driven instead of tools", () => {
  const tools: any[] = chatModule.default().tools || [];
  for (const name of [
    "get_chat_msg",
    "list_chat_log",
    "save_chat_user_identity",
  ]) {
    assert.equal(
      tools.some((tool) => tool.name === name),
      false,
      `${name} should not be exposed as a tool`,
    );
  }
});
