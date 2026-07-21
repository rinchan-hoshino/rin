# Rich Text Output Format

Use this document when a Rin reply or chat send needs native platform objects: mentions, quote/reply targets, images, files, video, audio, or stickers.

Rich output is an output contract. It must provide the exact ids or resource paths an adapter needs, plus readable fallback text for platforms with different native support.

## Prompt brief

Target surface:

- model final replies that include rich-object Markdown;
- SDK/outbox sends with structured `parts`;
- adapter renderers that convert rich objects to platform-native messages.

Goal:

- express native chat objects in a format Rin can parse and adapters can deliver, while keeping recipient-visible text useful across fallback paths.

Trusted inputs:

- platform user ids from chat metadata or adapter APIs;
- platform message ids from inbound quote nodes or stored message records;
- local artifact paths on the machine running Rin;
- recipient-accessible URLs;
- SDK/outbox delivery results.

Output contract:

- visible explanatory text;
- exact mention ids, quote ids, and attachment paths/URLs;
- rich-object Markdown or structured `parts`;
- delivery verification when the attachment or native object matters.

## Success criteria

A rich output is correct when:

- every native mention has an exact platform user id;
- every quote/reply target has an exact platform message id;
- every attachment has a local `path` or accessible `url`;
- visible text remains understandable when an adapter falls back to plain text;
- important file/image delivery is verified through outbox, adapter, platform result, or stored delivery evidence.

## Markdown rich-object syntax

| Intent         | Syntax                                | Contract                                                                                |
| -------------- | ------------------------------------- | --------------------------------------------------------------------------------------- |
| Native mention | `[@name](at:<platform-user-id>)`      | `platform-user-id` is the exact platform user id.                                       |
| Native mention | `[@name](mention:<platform-user-id>)` | Alias for `at:`. Prefer `at:` in new examples.                                          |
| Quote reply    | `[quote:<message-id>]`                | `message-id` is the exact platform message id.                                          |
| Quote reply    | `[label](quote:<message-id>)`         | Link-form quote; the link target supplies the reply id.                                 |
| Image          | `[image: name](url-or-local-path)`    | `name` is a readable label or filename; target is local path or URL.                    |
| Image          | `![alt](url-or-local-path)`           | Standard Markdown image syntax also creates an image object.                            |
| File           | `[file: name](url-or-local-path)`     | Generic attachment object.                                                              |
| Video          | `[video: name](url-or-local-path)`    | Video attachment object for adapters that support video.                                |
| Audio          | `[audio: name](url-or-local-path)`    | Audio attachment object for adapters that support audio.                                |
| Sticker        | `[sticker: name](url-or-local-path)`  | Sticker attachment object for adapters that support the target sticker resource format. |

Example:

```md
Hi [@Alice](at:12345), please check this.

[quote:987654321]
Replying to the exact platform message.

[image: room-plan.png](/tmp/rin/room-plan.png)
Here is the preview.

[file: debug-log.txt](/tmp/rin/debug-log.txt)
Full log.
```

Markdown contract:

- Raw `@name` is visible text; native mention syntax supplies the platform id.
- Quote is part of the ordered rich message, not separate message metadata. The first quote object supplies the reply target for adapters that support reply/quote delivery.
- An inbound quote node is an ID-only lazy reference under the current `chatKey`. Do not inject the referenced message body into the current prompt; call `chat_message_get` with that exact `chatKey` and message ID only when the request depends on it, and follow any nested quote node only as needed.
- For outbound delivery, quote context belongs in visible text only when recipient understanding depends on it.
- Local paths refer to files on the machine running Rin. Prefer absolute paths for generated artifacts.
- URLs should be reachable by the adapter/recipient and free of credential-bearing query data.
- Media/file labels become fallback text and sometimes attachment names.

## Structured `parts` for scripts

Use `parts` when scripting a chat send with the Agent SDK or outbox payloads. Structured parts avoid Markdown parsing ambiguity and make mixed text, quote targets, mentions, and attachments explicit.

```js
await rin.chat.send({
  chatKey: "telegram/123456:7890",
  parts: [
    { type: "quote", id: "987654321" },
    { type: "text", text: "Hi " },
    { type: "at", id: "12345", name: "Alice" },
    { type: "text", text: ", here is the preview." },
    { type: "image", path: "/tmp/rin/preview.png", mimeType: "image/png" },
    {
      type: "file",
      path: "/tmp/rin/debug-log.txt",
      name: "debug-log.txt",
      mimeType: "text/plain",
    },
  ],
});
```

Supported part shapes:

```ts
type ChatMessagePart =
  | { type: "text"; text: string }
  | { type: "markdown"; text: string }
  | { type: "at"; id: string; name?: string }
  | { type: "quote"; id: string }
  | { type: "image"; path?: string; url?: string; mimeType?: string }
  | {
      type: "file";
      path?: string;
      url?: string;
      name?: string;
      mimeType?: string;
    }
  | {
      type: "video" | "audio" | "sticker";
      path?: string;
      url?: string;
      name?: string;
      mimeType?: string;
    };
```

Structured part contract:

- `at.id` supplies the platform user id.
- `quote.id` supplies the platform message id. The first quote part becomes the reply target.
- Media/file parts supply either `path` or `url`.
- `file.name`, video/audio/sticker `name`, and `mimeType` improve adapter behavior and fallback records.
- `text` is plain text. `markdown` may contain normal Markdown plus rich-object syntax.

## Media ordering and captions

Media parts are delivery boundaries. Adapters send text runs and media parts as separate platform messages in rich-part order instead of moving text across media or trying to force a shared bubble.

Caption fields are used only when the platform requires them for a media-only send. Do not rely on a caption to bind explanatory text to an image; put the visible context in adjacent text and let the adapter preserve order.

Example:

```md
This text is sent first.
[image: preview.png](/tmp/rin/preview.png)
This text is sent after the image.
```

## Platform behavior and fallback

Adapters choose the best native representation they support:

- Telegram renders supported Markdown as HTML and native mentions as `tg://user?id=...` links.
- OneBot renders native mentions as CQ at elements, strips unsupported Markdown formatting from plain text, and embeds local media as `base64://` CQ payloads.
- Discord and Slack generally preserve Markdown-style text and map reply/thread behavior through their adapter APIs.
- Feishu/Lark serializes blank-line-separated Markdown blocks as native post paragraphs, and uploads local or remote image content to obtain an `image_key` before sending a native image message.
- Other adapters may strip Markdown formatting or send readable fallback text.

Fallback contract:

- Include a readable display name in text when human context matters.
- Include enough visible quote context for readers when native quote delivery is unavailable.
- Treat sticker/video/audio delivery as complete after adapter result or stored delivery evidence confirms it.
- Verify owner-visible delivery for important generated artifacts.

## Attachment delivery contract

When a generated or local artifact should reach the recipient:

1. Verify the file exists at the path to send.
2. Send `[image: name](path)` / `[file: name](path)` in a final reply, or a structured `parts` attachment in SDK code.
3. Include short visible text describing the attachment.
4. Verify the outbox/platform result when delivery matters.

Example final text:

```md
[image: preview.png](/tmp/rin/preview.png)
Here is the preview.
```

## Validation checks

Before sending rich output, check:

- exact platform user id for native mention;
- exact platform message id for quote/reply;
- existing local path or reachable URL for attachment;
- readable fallback text;
- delivery evidence path for important attachments;
- chat identity/log lookup path in `docs/chat-bridge.md` when an id is missing.

## Read next

- Chat identity, logs, adapters, outbox, and delivery troubleshooting: `docs/chat-bridge.md`.
- SDK import and `rin.chat.send` / `rin.chat.evalBridge`: `docs/agent-sdk.md`.
- Scheduled chat delivery: `docs/scheduled-tasks.md`.
