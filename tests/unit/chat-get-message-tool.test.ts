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

function findTool(tools: any[], name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} should be exposed as a model tool`);
  return tool;
}

function toolContext(frontend: unknown) {
  return { frontend };
}

test("chat exposes explicit-target message read tools", async () => {
  const requests: any[] = [];
  const tools: any[] = chatModule.default({
    request: async (command: any) => {
      requests.push(command);
      return {
        messageId: "message-1",
        chatKey: "telegram/bot-1:room-1",
        role: "user",
        text: "hello",
      };
    },
  }).tools;

  const get = findTool(tools, "chat_message_get");
  const list = findTool(tools, "chat_message_list");
  assert.equal(Object.hasOwn(get.parameters.properties, "chatKey"), true);
  assert.equal(Object.hasOwn(list.parameters.properties, "chatKey"), true);
  assert.ok(get.parameters.required.includes("chatKey"));
  assert.ok(list.parameters.required.includes("chatKey"));
  assert.equal(
    tools.some((tool) => tool.name === "chat_bridge"),
    false,
    "the general bridge evaluator must stay unavailable",
  );

  const result = await get.execute(
    "call-1",
    {
      chatKey: "discord/bot-2:other-room",
      messageId: "message-1",
    },
    undefined,
    undefined,
    toolContext({ kind: "chat", key: "telegram/bot-1:room-1" }),
  );

  assert.deepEqual(requests, [
    {
      type: "chat_message_get",
      payload: {
        chatKey: "discord/bot-2:other-room",
        messageId: "message-1",
      },
    },
  ]);
  assert.match(result.content[0].text, /"messageId": "message-1"/);
});

test("chat message tools reject missing and malformed explicit chat keys", async () => {
  let requests = 0;
  const tools: any[] = chatModule.default({
    request: async () => {
      requests += 1;
      return null;
    },
  }).tools;
  const get = findTool(tools, "chat_message_get");

  await assert.rejects(
    get.execute(
      "call-2",
      { messageId: "message-1" },
      undefined,
      undefined,
      toolContext({ kind: "chat", key: "telegram/bot-1:room-1" }),
    ),
    /chat_message_store_chatKey_required/,
  );
  await assert.rejects(
    get.execute(
      "call-3",
      { chatKey: "not-a-chat-key", messageId: "message-1" },
      undefined,
      undefined,
      toolContext({ kind: "chat", key: "telegram/bot-1:room-1" }),
    ),
    /chat_message_store_chatKey_required/,
  );
  assert.equal(requests, 0);
});

test("chat tool output stays bounded and valid when message bodies are large", async () => {
  const largeMessage = {
    messageId: "message-large",
    text: "x".repeat(60_000),
  };
  const largeList = Array.from({ length: 100 }, (_, index) => ({
    messageId: `message-${index}`,
    text: "y".repeat(5_000),
  }));
  const tools: any[] = chatModule.default({
    request: async (command: any) =>
      command.type === "chat_message_get" ? largeMessage : largeList,
  }).tools;
  const ctx = toolContext({ kind: "chat", key: "telegram/bot-1:room-1" });

  const getResult = await findTool(tools, "chat_message_get").execute(
    "call-large-get",
    {
      chatKey: "telegram/bot-1:room-1",
      messageId: "message-large",
    },
    undefined,
    undefined,
    ctx,
  );
  assert.ok(Buffer.byteLength(getResult.content[0].text, "utf8") <= 48 * 1024);
  const parsedGet = JSON.parse(getResult.content[0].text);
  assert.equal(parsedGet.result.messageId, "message-large");
  assert.match(parsedGet.result.text, /^x{1000}/);
  assert.match(parsedGet.result.text, /\[truncated \d+ chars\]$/);
  assert.ok(parsedGet.truncation.stringsTruncated > 0);

  const listResult = await findTool(tools, "chat_message_list").execute(
    "call-large-list",
    { chatKey: "discord/bot-2:room-2", limit: 100 },
    undefined,
    undefined,
    ctx,
  );
  assert.ok(Buffer.byteLength(listResult.content[0].text, "utf8") <= 48 * 1024);
  const parsedList = JSON.parse(listResult.content[0].text);
  assert.ok(parsedList.result.length < largeList.length);
  assert.equal(parsedList.truncation.paginationRecommended, true);
  assert.ok(parsedList.truncation.arrayItemsOmitted > 0);
});

test("chat message list keeps bounded explicit-target pagination", async () => {
  const requests: any[] = [];
  const tools: any[] = chatModule.default({
    request: async (command: any) => {
      requests.push(command);
      return [];
    },
  }).tools;
  const list = findTool(tools, "chat_message_list");

  await list.execute(
    "call-4",
    {
      chatKey: "discord/bot-2:room-2",
      before: "message-9",
      limit: 999,
    },
    undefined,
    undefined,
    toolContext({ kind: "chat", key: "discord/bot-2:room-2" }),
  );
  await list.execute(
    "call-5",
    { chatKey: "telegram/bot-1:room-1" },
    undefined,
    undefined,
    toolContext({ kind: "tui" }),
  );

  assert.deepEqual(requests, [
    {
      type: "chat_message_list",
      payload: {
        chatKey: "discord/bot-2:room-2",
        before: "message-9",
        limit: 100,
      },
    },
    {
      type: "chat_message_list",
      payload: {
        chatKey: "telegram/bot-1:room-1",
        limit: 20,
      },
    },
  ]);
});
