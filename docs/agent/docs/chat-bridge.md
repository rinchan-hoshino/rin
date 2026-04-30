# Chat Bridge Tool

`chat_bridge` runs constrained TypeScript/JavaScript code against the live chat bridge runtime.

## When to use it

Use `chat_bridge` for tasks such as:

- sending a message to a specified chat
- sending mixed text / mention / image / file content
- using platform-specific bridge APIs
- chat management actions
- complex interactive chat flows

## Built-in direct runtime adapters

The built-in direct runtime currently includes:

- Telegram
- OneBot
- QQ
- Feishu / Lark
- Discord
- Slack
- Minecraft / QueQiao

## Runtime objects

The code runs as an async function body.

Available globals:

- `chat`
  - current bound chat scope when the current session is already bound to a chat
  - `null` when there is no current bound chat
- `bot`
  - intentionally thin shared bridge surface for the current bound chat scope
  - primarily for the minimal common send path and a few stable fields
- `internal`
  - primary platform-specific API for the current bound chat scope
  - prefer this for most chat-platform operations
  - some platforms also expose bound official client objects such as `internal.client`, `internal.web`, `internal.openapi`, `internal.wsClient`, or `internal.ws`
- `h`
  - message element builder
- `store`
  - local message / chat-log helpers for the current bound chat scope
- `identity`
  - local trust helpers for the current bound chat scope
- `helpers`
  - bridge helpers

## `helpers`

- `helpers.currentChatKey`
  - current bound chat key, if any
- `helpers.useChat(chatKey)`
  - returns a bound scope for another chat
  - the returned object has:
    - `chat`
    - `bot`
    - `internal`
    - `h`
    - `store`
    - `identity`
    - `helpers`
- `helpers.send(input)`
  - tracked outbound send for the current bound scope
- `helpers.reply(replyToMessageId, input)`
  - tracked outbound reply for the current bound scope
- `helpers.serialize(value)`
  - safe JSON-like serialization helper

## Message input

`helpers.send()` and `helpers.reply()` accept either:

- a string
- one part object
- an array of parts
- an object with `parts`

Supported parts:

- `{ type: "text", text: "hello" }`
- `{ type: "markdown", text: "**hello**" }`
- `{ type: "at", id: "123", name?: "name" }`; `id` is required for native mentions
- `{ type: "quote", id: "456" }`
- `{ type: "image", path?: "/abs/file.png", url?: "https://...", mimeType?: "image/png" }`
- `{ type: "file", path?: "/abs/file.zip", url?: "https://...", name?: "file.zip", mimeType?: "application/zip" }`
- `{ type: "video", path?: "/abs/file.mp4", url?: "https://...", name?: "file.mp4", mimeType?: "video/mp4" }`
- `{ type: "audio", path?: "/abs/file.mp3", url?: "https://...", name?: "file.mp3", mimeType?: "audio/mpeg" }`
- `{ type: "sticker", path?: "/abs/file.webp", url?: "https://...", name?: "sticker.webp", mimeType?: "image/webp" }`

## Basic template

```ts
const scope = chat ?? helpers.useChat("telegram/8623230033:-1001234567890");

return await scope.internal.getChat({ chat_id: scope.chat.chatId });
```

## Examples

### Send text to a specified chat

```ts
const room = helpers.useChat("onebot/2301401877:1067390680");
await room.helpers.send("你好");
return "ok";
```

### Send mixed content

```ts
const room = helpers.useChat("telegram/8623230033:-1001234567890");
await room.helpers.send([
  { type: "text", text: "看这个" },
  { type: "image", url: "https://example.com/demo.png" },
]);
return "sent";
```

### Use the thin shared `bot` surface

```ts
const scope = helpers.useChat("telegram/8623230033:-1001234567890");
return await scope.bot.sendMessage(scope.chat.chatId, [scope.h.text("hello")]);
```

### Use a platform-specific method

```ts
const scope = helpers.useChat("telegram/8623230033:-1001234567890");
return await scope.internal.getChatMember({
  chat_id: scope.chat.chatId,
  user_id: 123456789,
});
```

### Use Telegram reaction through `internal`

```ts
const scope = chat ?? helpers.useChat("telegram/8623230033:-1001234567890");
const target = scope.store
  .listLog()
  .entries.filter((item) => item && item.role === "user" && item.messageId)
  .at(-1);
if (!target) throw new Error("no target message");
await scope.internal.setMessageReaction({
  chat_id: scope.chat.chatId,
  message_id: Number(target.messageId),
  reaction: [{ type: "emoji", emoji: "👍" }],
});
return { messageId: target.messageId, emoji: "👍" };
```

### Use Discord typing and reaction helpers

```ts
const scope = chat ?? helpers.useChat("discord/123456789012345678");
await scope.internal.sendTyping(scope.chat.chatId);
return await scope.internal.createReaction(
  scope.chat.chatId,
  "123456789012345679",
  "🔥",
);
```

### Use Slack Web API through `internal`

```ts
const scope = chat ?? helpers.useChat("slack/C0123456789");
return await scope.internal.postMessage({
  channel: scope.chat.chatId,
  text: "hello from chat_bridge",
});
```

### Use QQ channel or group send through `internal`

```ts
const scope = chat ?? helpers.useChat("qq/channel:1234567890");
return await scope.internal.postMessage(
  scope.chat.chatId.replace(/^channel:/, ""),
  {
    content: "hello",
    msg_type: 0,
  },
);
```

### Use Lark message create through `internal`

```ts
const scope = chat ?? helpers.useChat("lark/oc_xxxxxxxxxx");
return await scope.internal.createMessage({
  params: { receive_id_type: "chat_id" },
  data: {
    receive_id: scope.chat.chatId,
    msg_type: "text",
    content: JSON.stringify({ text: "hello" }),
  },
});
```

### Use Minecraft / QueQiao bridge actions

```ts
const scope = chat ?? helpers.useChat("minecraft/Survival");
return await scope.internal.sendRconCommand("list");
```

### Inspect local stored message context

```ts
const scope = chat ?? helpers.useChat("onebot/2301401877:1067390680");
return scope.store.getMessage("1234567890");
```

## Notes

- prefer `internal` for most platform operations
- treat `bot` as a very small shared surface rather than the main capability layer
- use `helpers.useChat(chatKey)` when you need to act on a different chat
- returned values are passed through with safe serialization when needed
