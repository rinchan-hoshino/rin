# Rich Text Output Format

Use this when a Rin output needs native platform objects instead of plain text.

Rin accepts structured rich parts from code and Markdown rich-object syntax from model replies. If a target adapter cannot send a requested object natively, Rin keeps the message readable as plain text.

## Markdown rich-object syntax

| Intent         | Syntax                               | Notes                                                                  |
| -------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| Native mention | `[@name](at:<platform-user-id>)`     | Use the exact platform user id. Raw `@name` text is visible text only. |
| Quote reply    | `[quote:<message-id>]`               | Uses the exact platform message id as the reply target.                |
| Image          | `[image: name](url-or-local-path)`   | `name` should be a readable filename or short label.                   |
| File           | `[file: name](url-or-local-path)`    | Use for generic file attachments.                                      |
| Video          | `[video: name](url-or-local-path)`   | Use only when the target can receive video.                            |
| Audio          | `[audio: name](url-or-local-path)`   | Use only when the target can receive audio.                            |
| Sticker        | `[sticker: name](url-or-local-path)` | Use only when the target can receive stickers.                         |

## Practical rules

- Use native mentions only when the exact platform user id is known.
- Use quote replies only with the exact platform message id from the current context or message store.
- Prefer local files or already accessible URLs for attachments; do not expose private credentials in attachment URLs.
- Keep fallback text understandable because unsupported rich objects degrade to readable plain text.
