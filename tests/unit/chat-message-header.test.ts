import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const messageHeaderMod = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat-bridge", "message-header.js"),
  ).href
);
const promptContextMod = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat-bridge", "prompt-context.js"),
  ).href
);

function createHandlers() {
  return messageHeaderMod.default().hooks;
}

test("chat prompt context keeps dynamic sender fields in the prompt header", () => {
  const meta = {
    source: "chat-bridge",
    sentAt: 1710000000000,
    chatKey: "telegram/1:2",
    chatType: "group",
    userId: "guest-1",
    nickname: "AliceAccount",
    groupNickname: "AliceCard",
    identity: "OTHER",
  };
  const promptText = promptContextMod.formatPromptContext(meta, "hello");
  const systemBlock =
    promptContextMod.formatPromptContextSystemPromptBlock(meta);

  assert.ok(promptText.startsWith("time: "));
  assert.equal(promptText.includes("chatKey: telegram/1:2"), false);
  assert.ok(promptText.includes("sender nickname: AliceAccount"));
  assert.ok(promptText.includes("sender group nickname: AliceCard"));
  assert.equal(promptText.includes("sender account nickname:"), false);
  assert.ok(promptText.includes("sender trust: other chat user"));
  assert.ok(systemBlock.includes("- chatKey: telegram/1:2"));
  assert.ok(
    systemBlock.includes(
      "- runtime note: header lines above `---` are runtime metadata for this message, not user-authored text.",
    ),
  );
  assert.ok(
    systemBlock.includes(
      "- sender trust note: owner means the owner, trusted user means a known trusted chat user, and other chat user means any other chat user.",
    ),
  );
  assert.equal(systemBlock.includes("sender nickname: AliceAccount"), false);
  assert.equal(systemBlock.includes("sender trust: other chat user"), false);
  assert.equal(promptText.includes("sender is owner:"), false);
  assert.ok(promptText.endsWith("---\nhello"));
});

test("prompt context header injection is reusable and idempotent", () => {
  const promptText = promptContextMod.injectPromptContextHeader(
    {
      source: "chat-bridge",
      sentAt: 1710000000000,
      chatKey: "telegram/1:2",
      userId: "guest-1",
      nickname: "Alice",
      identity: "OTHER",
    },
    "hello",
  );
  const reinjected = promptContextMod.injectPromptContextHeader(
    {
      source: "chat-bridge",
      sentAt: 1710000000000,
      chatKey: "telegram/1:2",
      userId: "guest-1",
      nickname: "Alice",
      identity: "OTHER",
    },
    promptText,
  );

  assert.equal(reinjected, promptText);
  assert.equal(promptText.match(/^time: /gm)?.length, 1);
  assert.ok(promptText.endsWith("---\nhello"));
});

test("message header skips duplicate metadata for already formatted chat prompts", async () => {
  const handlers = createHandlers();

  const promptText = promptContextMod.formatPromptContext(
    {
      source: "chat-bridge",
      sentAt: Date.now(),
      chatKey: "onebot/1:2",
      chatType: "group",
      userId: "guest-1",
      nickname: "CoolUser",
      identity: "OTHER",
    },
    "@RinBot my name is?",
  );

  const inputResult = await handlers.input[0]({
    source: "chat-bridge",
    text: promptText,
  });
  assert.deepEqual(inputResult, { action: "continue" });

  const beforeStart = await handlers.before_agent_start[0]({
    prompt: promptText,
    systemPrompt: "Base prompt",
  });

  assert.deepEqual(beforeStart, {});
});

test("message header formats structured chat prompt context at the shared input hook", async () => {
  const handlers = createHandlers();

  const inputResult = await handlers.input[0]({
    source: "chat-bridge",
    text: "hello",
    promptContext: {
      source: "chat-bridge",
      sentAt: 1710000000000,
      chatKey: "telegram/1:2",
      chatType: "group",
      userId: "guest-1",
      nickname: "Alice",
      identity: "OTHER",
    },
  });
  assert.deepEqual(inputResult, { action: "continue" });

  const beforeStart = await handlers.before_agent_start[0]({
    prompt: "hello",
    systemPrompt: "Base prompt",
    promptContext: {
      source: "chat-bridge",
      sentAt: 1710000000000,
      chatKey: "telegram/1:2",
      chatType: "group",
      userId: "guest-1",
      nickname: "Alice",
      identity: "OTHER",
    },
  });

  const header = String(beforeStart?.message?.content || "");
  assert.equal(header.includes("chatKey: telegram/1:2"), false);
  assert.ok(header.includes("sender nickname: Alice"));
  assert.ok(header.endsWith("---\nhello"));
  assert.equal(beforeStart?.message?.display, false);
  assert.ok(
    String(beforeStart?.systemPrompt || "").includes(
      "Chat context:\n- chatKey: telegram/1:2",
    ),
  );
});

test("message header still injects a local hidden timestamp for non-chat prompts", async () => {
  const handlers = createHandlers();

  const inputResult = await handlers.input[0]({
    source: "user",
    text: "hello",
  });
  assert.deepEqual(inputResult, { action: "continue" });

  const beforeStart = await handlers.before_agent_start[0]({
    prompt: "hello",
    systemPrompt: "Base prompt",
  });

  const header = String(beforeStart?.message?.content || "");
  assert.ok(header.startsWith("time: "));
  assert.ok(header.endsWith("---\nhello"));
  assert.equal(String(beforeStart?.systemPrompt || ""), "");
});

test("chat prompt context keeps reply id metadata without embedding lookup guidance", () => {
  const promptText = promptContextMod.formatPromptContext(
    {
      source: "chat-bridge",
      sentAt: Date.now(),
      chatKey: "telegram/1:2",
      chatType: "group",
      userId: "guest-1",
      nickname: "Alice",
      identity: "OTHER",
      replyToMessageId: "quoted-42",
    },
    "what does this mean?",
  );

  assert.ok(promptText.includes("reply to message id: quoted-42"));
  assert.equal(promptText.includes("reply message:"), false);
  assert.equal(promptText.includes("first line"), false);
  assert.equal(promptText.includes("reply lookup"), false);
});

test("chat prompt context keeps owner and trusted senders distinct", () => {
  const ownerPrompt = promptContextMod.formatPromptContext(
    {
      source: "chat-bridge",
      sentAt: Date.now(),
      chatKey: "telegram/1:2",
      chatType: "private",
      userId: "owner-1",
      nickname: "Master",
      identity: "OWNER",
    },
    "hello",
  );
  const trustedPrompt = promptContextMod.formatPromptContext(
    {
      source: "chat-bridge",
      sentAt: Date.now(),
      chatKey: "telegram/1:2",
      chatType: "group",
      userId: "trusted-1",
      nickname: "Bob",
      identity: "TRUSTED",
    },
    "hello",
  );

  assert.ok(ownerPrompt.includes("sender trust: owner"));
  assert.ok(trustedPrompt.includes("sender trust: trusted user"));
  assert.equal(ownerPrompt.includes("sender is owner:"), false);
  assert.equal(trustedPrompt.includes("sender is owner:"), false);
});
