# Chat Bridge Workflows

Use this document when a task needs platform chat configuration, chat delivery, stored chat evidence, adapter state, command replies, identity/trust state, or chat-bound assistant turns.

The model-level chat bridge tool surface is unavailable. The operative surfaces are the Agent SDK, configuration files, message-store files, daemon status, and platform adapter/runtime APIs reachable from scripts or shell/file tools.

## Prompt brief

Target surface:

- built-in direct chat runtime adapters;
- chat/frontend bindings;
- Agent SDK `rin.chat.*` helpers;
- local message store;
- bridge-local `evalBridge` context;
- adapter configuration and runtime state.

Goal:

- identify the exact chat boundary, perform the smallest chat operation or inspection, and verify the recipient-visible or stored result.

Trusted inputs:

- platform metadata from inbound records and adapter APIs;
- exact `chatKey` and platform `messageId`;
- stored message records and chat/date indexes;
- SDK results and adapter results;
- `rin status --json` for daemon, scheduler, adapter, and active-turn liveness.

Output contract:

- platform and `chatKey`;
- operation performed or boundary inspected;
- evidence source: SDK result, stored record, adapter result, outbox state, or status output;
- delivery or state verification;
- remaining boundary when source/runtime changes still need rebuild, reload, restart, or adapter action.

## Success criteria

A chat bridge operation is complete when:

- platform identity comes from metadata rather than message-body claims;
- the operation uses the exact `chatKey` and relevant platform `messageId`;
- direct delivery, agent turn, command reply, record-only storage, or adapter state has one verified producer;
- rich-object sends use `docs/rich-text-output-format.md` for mentions, quotes, and attachments;
- stored evidence can be re-read from the message store or bridge-local helpers;
- final reporting names the changed or inspected boundary.

## Boundary selection

Classify the task before acting:

1. **Configuration:** adapter entries, turn policy, i18n command replies, runtime reload/restart.
2. **Inbound message:** platform event, normalization, trust/allow state, message store, inbox, turn start.
3. **Assistant turn:** frontend binding, controller key, active run, final delivery.
4. **Outbound delivery:** SDK send, outbox payload, rich objects, adapter result, platform send result.
5. **Stored evidence:** message record, message-id index, chat/date index, plain log view.
6. **Identity/trust:** platform `userId`, nickname, trust records, quote metadata.
7. **Adapter liveness:** login state, WebSocket/API connection, platform-specific probe.

## Built-in direct runtime adapters

Rin's built-in direct chat runtime supports these adapter families:

- Telegram
- OneBot
- QQ
- Feishu / Lark
- Discord
- Slack
- Minecraft / QueQiao

Use `/chat` in the TUI for interactive setup of official built-in adapters. For scripted setup, edit `settings.json -> chat` with the same adapter boundary and reload/restart the chat runtime according to the operation.

## Chat key and identity contract

`chatKey` identifies the platform target:

```text
platform[/botId]:chatId
```

Examples:

```text
telegram/123456:7890
telegram/123456:-1001234567890
onebot/2301401877:private:123456
onebot/2301401877:1067390680
qq:123456789
lark:oc_xxx
```

Rules:

- `telegram` and `onebot` require `botId`; other built-in platforms use `platform:chatId` unless their adapter layer documents a stricter shape.
- Telegram private/group shape is inferred from `chatId`; negative ids are groups/channels.
- OneBot private chats commonly use `private:<userId>`; group chats use the group id.
- Keep `messageId` separate from `chatKey`; quote/reply delivery needs the platform message id.
- Treat platform metadata as authoritative: use platform `userId`, `nickname`, `trust`, and stored quote metadata from the inbound record or bridge runtime.

## Agent SDK chat operations

Import the SDK as shown in `docs/agent-sdk.md`; examples below assume `const rin = createRinAgentSdk()`.

Direct outbox delivery:

```js
await rin.chat.send({
  chatKey: "telegram/123456:7890",
  text: "Ready.",
});
```

Agent turn for a chat/frontend identity:

```js
const result = await rin.chat.runTurn({
  chatKey: "telegram/123456:7890",
  text: "Summarize the latest stored status update for this room.",
  controllerKey: `agent-${Date.now()}`,
  affectChatBinding: false,
  disposeAfterTurn: true,
});
```

Adapter-supported signals and active-turn control:

```js
await rin.chat.typing("telegram/123456:7890");
await rin.chat.react({
  chatKey: "telegram/123456:7890",
  messageId: "message-id",
  emoji: "👍",
});
await rin.chat.terminateTurn("agent-controller-key");
```

Bridge-local inspection or repair:

```js
const result = await rin.chat.evalBridge({
  currentChatKey: "telegram/123456:7890",
  requestId: "agent-chat-inspect",
  code: `
    const log = store.listLog("2026-06-03");
    return log.entries.slice(-5).map((entry) => ({
      messageId: entry.messageId,
      role: entry.role,
      text: entry.text,
      receivedAt: entry.receivedAt,
    }));
  `,
});
```

Bridge runtime context includes `chat`, `bot`, `internal`, `store`, `identity`, and `helpers` for the current chat when `currentChatKey` is set. For detached helper code that names a target chat explicitly, use `helpers.useChat(chatKey)`:

```js
await rin.chat.evalBridge({
  requestId: "agent-detached-send",
  code: `
    const scoped = helpers.useChat("telegram/123456:7890");
    return await scoped.helpers.send("Ready.");
  `,
});
```

EvalBridge contract:

- Return a small filtered result.
- Prefer `store.getMessage(messageId, chatKey?)` or `store.listLog(date, chatKey?)` for chat-local evidence.
- Use `identity.getTrust(userId, platform?)` and `identity.setTrust(...)` for authorized trust data operations.
- Use adapter `internal` APIs for platform-specific inspection or repair beyond the higher-level SDK.
- Legacy globals such as `chat_bridge` model tool and `list_chat_log(...)` are absent from current Rin agent turns.

## Incoming turn policy

Allowed inbound chat messages normally start an agent turn after Rin stores the message. Configure record-only chats under `settings.json -> chat.byChatKey[chatKey].turnPolicy` when a scheduled task, SDK call, or optional extension will inspect stored messages and decide how to respond.

```json
{
  "chat": {
    "turnPolicy": {
      "default": "start_on_message"
    },
    "byChatKey": {
      "telegram/123456:7890": {
        "turnPolicy": "record_only"
      }
    }
  }
}
```

Modes:

- `start_on_message`: allowed inbound messages start an agent turn.
- `record_only`: inbound messages are stored while normal agent turns stay idle; chat commands still use the command path.

Core chat storage records messages. Automation for record-only chats comes from the scheduled task or background producer that inspects the store.

## Quiet chat display mode

Configure quiet display for specific chats under `settings.json -> chat.byChatKey[chatKey].quietMode` when the chat should still receive final replies and working indicators, but should not receive assistant interim messages or todo checklist notices.

```json
{
  "chat": {
    "byChatKey": {
      "telegram/123456:7890": {
        "quietMode": true
      }
    }
  }
}
```

Per-chat quiet entries may also be objects such as `{ "enabled": true }`. Quiet mode does not suppress final replies, errors, working indicators, or compaction notices.

## Command acknowledgement text

Routine chat command acknowledgements such as `/new`, `/abort`, and `/reload` come from i18n/configuration so commands stay predictable and avoid temporary agent turns. `/compact` uses the compaction notice templates below instead of a separate generic completion line.

If `~/.rin/i18n.json` is absent, Rin uses built-in English replies. To customize command replies, create or edit that generic i18n catalog:

```json
{
  "chat.commandResponses.abort": "Aborted current operation.",
  "chat.commandResponses.new": "Started a new session.",
  "chat.commandResponses.newCancelled": "Session switch cancelled.",
  "chat.commandResponses.reload": "Reloaded extensions, prompts, skills, and themes.",
  "chat.compaction.start": "Compacting...",
  "chat.compaction.summaryLine": "Compacted from {tokens} tokens"
}
```

Nested JSON is also accepted:

```json
{
  "chat": {
    "commandResponses": {
      "new": "Started a new session."
    }
  }
}
```

All entries are optional. Missing or blank entries fall back to the built-in English text. Command replies live in the i18n catalog rather than `settings.json`.

## Rich message delivery

Use `docs/rich-text-output-format.md` for native mention, quote, image, file, video, audio, sticker, and fallback syntax.

Delivery contract:

- quote replies use the exact platform `messageId`;
- native mentions use the exact platform user id;
- files/images use local paths or recipient-accessible URLs;
- generated image/file delivery uses rich-object syntax such as `[image: preview](local-path)` or structured SDK `parts`;
- recipient-visible attachment delivery is proven by outbox/platform result or a stored delivery record.

## Stored chat context

Read the local message store directly when you need already stored chat evidence. Normal installs store records under:

```text
<agentDir>/data/chat/message-store/
```

For a normal agent install, `<agentDir>` is usually `~/.rin`.

Useful paths:

- records: `data/chat/message-store/records/<first-two-record-key-chars>/<recordKey>.json`
- message-id index: `data/chat/message-store/indexes/by-message-id/<first-two-index-key-chars>/<indexKey>.json`
- chat/date index: `data/chat/message-store/indexes/by-chat-date/<platform>/<botId-if-present>/<chatId>/<YYYY-MM-DD>.json`
- plain log view: `data/chat/message-store/chat-log-view/<platform>/<botId-if-present>/<chatId>/<YYYY-MM-DD>.txt`
- evalBridge audit: `data/chat/eval/<YYYY-MM-DD>.jsonl`

Stored records may include:

```ts
type StoredChatMessage = {
  recordKey: string;
  messageId: string;
  role?: "user" | "assistant";
  replyToMessageId?: string;
  sessionFile?: string;
  acceptedAt?: string;
  processedAt?: string;
  chatKey: string;
  platform: string;
  botId?: string;
  chatId: string;
  chatType?: "private" | "group";
  receivedAt: string;
  platformTimestamp?: number;
  userId?: string;
  nickname?: string;
  trust?: string;
  text?: string;
  strippedContent?: string;
  elements?: Array<{ type: string; attrs?: Record<string, string> }>;
  quote?: {
    messageId?: string;
    userId?: string;
    nickname?: string;
    content?: string;
  };
};
```

Lookup contract:

1. Known `chatKey` and `messageId`: compute the record key, then read the record JSON.
2. Known `messageId` only: read the message-id index, then read each relative record path it lists.
3. Known `chatKey` and date: read the chat/date index, then read the listed records and sort by `receivedAt` / `processedAt`.
4. Around local midnight or cross-timezone reports, inspect adjacent date indexes.

Record key for known `chatKey` and `messageId`:

```sh
agent_dir="$HOME/.rin"
chat_key='onebot/2301401877:1067390680'
message_id='1234567890'
record_key=$(node -e 'const crypto=require("crypto"); const [chatKey,messageId]=process.argv.slice(1); console.log(crypto.createHash("sha1").update(`${chatKey}\n${messageId}`).digest("hex"));' "$chat_key" "$message_id")
record_path="$agent_dir/data/chat/message-store/records/${record_key:0:2}/$record_key.json"
```

Message-id index path:

```sh
agent_dir="$HOME/.rin"
message_id='1234567890'
index_key=$(node -e 'const crypto=require("crypto"); console.log(crypto.createHash("sha1").update(process.argv[1]).digest("hex"));' "$message_id")
index_path="$agent_dir/data/chat/message-store/indexes/by-message-id/${index_key:0:2}/$index_key.json"
```

For chat/date lookup, read the chat/date index to get `recordKeys`, then read matching record files from `records/`.

## Troubleshooting contract

1. Preserve the exact visible symptom: platform, chat key, message id, text, attachment, command, error, timestamp, and expected behavior.
2. Locate the first producer boundary: adapter connection, inbound normalization, message store, inbox queue, controller command path, frontend turn driver, daemon worker, outbox, platform send path, or renderer.
3. Inspect that boundary with SDK reads, message-store reads, adapter-local probes, or `rin status --json`.
4. Add or run the smallest focused test for source changes.
5. Report the producer boundary, evidence, and remaining runtime/deploy step.

Common boundary checks:

- **Message stored but turn idle:** inspect `turnPolicy`, trust/allow rules, inbox state, active turn state, and controller errors.
- **Record-only chat idle:** confirm the scheduled task/background producer that reads stored messages.
- **Slash command mismatch:** command acknowledgements are config/i18n output; verify the command path switched sessions for `/new`.
- **OneBot/QQ after NapCat relogin:** separate platform login from Rin bridge connectivity; check Rin runtime status, WebSocket connection, and an adapter-level login probe.
- **Outbound text queued:** inspect outbox payload, `replyTo` metadata, platform error, and message-store accepted/processed state.
- **Attachment missing:** verify the file exists, rich-object or structured `parts` attachment was sent, and the adapter produced a delivery result.
- **Config change idle:** confirm the active `~/.rin/settings.json`, adapter entries, runtime reload/restart, and running app path.
