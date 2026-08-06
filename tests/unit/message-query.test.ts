import test from "node:test";
import assert from "node:assert/strict";

import { importBuiltModule } from "../support/import-built-module.js";

await import("../support/register-message-query-owner-fixture.ts");

const {
  canonicalizeChatMessageRead,
  getChatMessageRead,
  listChatMessageReads,
} = await importBuiltModule<
  typeof import("../../src/core/chat/message-query.js")
>("dist/core/chat/message-query.js");

test("message reads canonicalize legacy reply metadata into one quote node", () => {
  const read = canonicalizeChatMessageRead({
    chatKey: "discord:g:c",
    messageId: "m1",
    direction: "inbound",
    senderId: "u1",
    text: "hello",
    elements: [{ type: "text", attrs: { text: "hello" }, children: [] }],
    replyToMessageId: "quoted",
    timestamp: 1,
  } as any);
  assert.equal(Object.hasOwn(read, "replyToMessageId"), false);
  assert.deepEqual(read.elements[0], {
    type: "quote",
    attrs: { id: "quoted" },
    children: [],
  });
});

test("message reads preserve one canonical nested quote and drop malformed quotes", () => {
  const read = canonicalizeChatMessageRead({
    elements: [
      null,
      "invalid",
      { type: "quote", attrs: {}, children: [] },
      {
        type: "paragraph",
        attrs: {},
        children: [
          { type: "quote", attrs: { messageId: "nested" }, children: [] },
        ],
      },
    ],
    quote: { messageId: "legacy" },
  } as any);
  assert.equal((read.elements[0] as any).type, "paragraph");
  assert.deepEqual((read.elements[0] as any).children[0].attrs, {
    id: "nested",
  });

  assert.deepEqual(
    canonicalizeChatMessageRead({ elements: null } as any).elements,
    [],
  );
});

test("message read queries canonicalize present records, lists, and missing rows", () => {
  const owner = globalThis as any;
  owner.__rinMessageQueryOwnerCalls.length = 0;
  owner.__rinMessageQueryOwnerRecord = {
    messageId: "one",
    elements: [],
    quote: { messageId: "quoted" },
  };
  owner.__rinMessageQueryOwnerRecords = [
    { messageId: "two", elements: [], replyToMessageId: "reply" },
  ];

  assert.equal(getChatMessageRead("/agent", "chat", "one")?.messageId, "one");
  owner.__rinMessageQueryOwnerRecord = null;
  assert.equal(getChatMessageRead("/agent", "chat", "missing"), null);
  assert.deepEqual(
    listChatMessageReads("/agent", { chatKey: "chat", limit: 2 } as any).map(
      (record) => record.elements[0]?.attrs?.id,
    ),
    ["reply"],
  );
  assert.deepEqual(owner.__rinMessageQueryOwnerCalls, [
    ["get", "/agent", "chat", "one"],
    ["get", "/agent", "chat", "missing"],
    ["list", "/agent", { chatKey: "chat", limit: 2 }],
  ]);
});
