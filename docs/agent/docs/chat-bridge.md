# Chat Bridge Workflows

Use this document when a task needs platform chat configuration, chat delivery, stored chat evidence, adapter state, command replies, identity/trust state, or chat-bound assistant turns.

The model-level chat bridge tool surface is unavailable. The operative surfaces are the Agent SDK, configuration files, read-only `chat.sqlite` evidence, daemon status, and platform adapter/runtime APIs reachable from scripts or shell/file tools.

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
6. **Identity/trust:** platform `userId`, nickname, trust records, and quote rich nodes.
7. **Adapter liveness:** login state, WebSocket/API connection, platform-specific probe.

## Built-in direct runtime adapters

Rin's built-in direct chat runtime supports these adapter families:

- Telegram
- OneBot
- Feishu / Lark
- Discord
- Slack
- Minecraft / QueQiao

Adapter lifecycle failures are isolated. If one configured adapter cannot initialize or connect, its status is `degraded`; other adapters continue starting and the core daemon remains available. If the whole hosted Chat service cannot start, daemon status reports Chat as degraded and Chat commands fail explicitly without taking down TUI, scheduler, workers, or daemon RPC.

Chat bridge configuration is agent-owned: edit `settings.json -> chat` directly, validate the JSON, then restart the target daemon so the hosted chat runtime reloads adapter entries. Do not rely on installer or TUI interactive adapter setup; those flows are intentionally absent.

Minimal built-in adapter examples:

```json
{
  "chat": {
    "telegram": {
      "token": "123456:ABCDEF...",
      "protocol": "polling",
      "slash": true
    },
    "onebot": {
      "endpoint": "ws://127.0.0.1:3001",
      "protocol": "ws",
      "selfId": "123456789",
      "token": ""
    },
    "lark": { "platform": "feishu", "appId": "cli_xxx", "appSecret": "secret" },
    "discord": { "token": "bot-token" },
    "slack": { "protocol": "ws", "token": "xapp-...", "botToken": "xoxb-..." },
    "minecraft": {
      "url": "ws://127.0.0.1:8080",
      "selfId": "minecraft",
      "serverName": "Survival",
      "token": ""
    }
  }
}
```

Use only the adapter entries the owner requested. For multiple accounts of the same adapter, use an array of entries with `name` fields under that adapter key. After writing settings, restart with the target-aware launcher, for example `rin restart` or `rin -u <user> restart`, then verify with `rin status --json` and an adapter-specific send or stored-message check.

## Chat key and identity contract

`chatKey` identifies the platform target:

```text
platform/botId:chatId
```

Examples:

```text
telegram/8623230033:7890
telegram/8623230033:-1001234567890
onebot/2301401877:private:123456
onebot/2301401877:1067390680
discord/1519908956212822117:1519903290694045796
lark/cli_xxx:oc_xxx
```

Rules:

- Every platform chat key uses the same bot-qualified shape: `platform/botId:chatId`.
- `botId` is the stable account/bot identity for the adapter instance, such as Telegram bot id, OneBot selfId, Discord bot id, Lark appId, Slack bot user id, or Minecraft selfId.
- Do not introduce platform-specific unqualified forms such as `platform:chatId`; migrate stored files and settings to the single canonical shape instead.
- Telegram private/group shape is inferred from `chatId`; negative ids are groups/channels.
- OneBot private chats commonly use `private:<userId>`; group chats use the group id.
- Keep `messageId` separate from `chatKey`; quote/reply delivery needs the platform message id.
- Treat platform metadata as authoritative for `userId`, `nickname`, and `trust`. Adapters must emit replies directly as ID-only structured quote nodes in inbound rich text; the runtime does not translate a separate session quote field.

## Agent SDK chat operations

Import the SDK as shown in `docs/agent-sdk.md`; examples below assume `const rin = createRinAgentSdk()`.

Direct outbox delivery:

```js
await rin.chat.send({
  chatKey: "telegram/8623230033:7890",
  text: "Ready.",
});
```

Agent turn for a chat/frontend identity:

```js
const result = await rin.chat.runTurn({
  chatKey: "telegram/8623230033:7890",
  text: "Summarize the latest stored status update for this room.",
  controllerKey: `agent-${Date.now()}`,
  affectChatBinding: false,
  disposeAfterTurn: true,
});
```

Adapter-supported signals and active-turn control:

```js
await rin.chat.typing("telegram/8623230033:7890");
await rin.chat.react({
  chatKey: "telegram/8623230033:7890",
  messageId: "message-id",
  emoji: "👍",
});
await rin.chat.terminateTurn("agent-controller-key");
```

Bridge-local inspection or repair:

```js
const result = await rin.chat.evalBridge({
  currentChatKey: "telegram/8623230033:7890",
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
    const scoped = helpers.useChat("telegram/8623230033:7890");
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
      "telegram/8623230033:7890": {
        "turnPolicy": "record_only"
      }
    }
  }
}
```

Modes:

- `start_on_message`: allowed inbound messages start an agent turn.
- `record_only`: inbound messages are stored while agent turns and chat slash commands stay idle.

Core chat storage records messages. Automation for record-only chats comes from the scheduled task or background producer that inspects the store.

## Quiet chat display mode

Configure quiet display for specific chats under `settings.json -> chat.byChatKey[chatKey].quietMode` when the chat should receive only final replies, independent error deliveries, and ordinary working indicators.

```json
{
  "chat": {
    "byChatKey": {
      "telegram/8623230033:7890": {
        "quietMode": true
      }
    }
  }
}
```

Per-chat quiet entries may also be objects such as `{ "enabled": true }`. Quiet mode does not inspect feature names such as todo or compaction; the delivery itself must use final delivery semantics to be sent.

## Per-chat model options

Configure a chat-specific model or thinking level under `settings.json -> chat.byChatKey[chatKey]` when a chat should use a different default from the global session settings.

```json
{
  "chat": {
    "byChatKey": {
      "telegram/8623230033:7890": {
        "model": "openai-codex/gpt-5.5",
        "thinkingLevel": "low"
      }
    }
  }
}
```

`model` uses `provider/model` format. `thinkingLevel` uses the normal Rin thinking level strings such as `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Per-chat options are applied to prompt turns after the session reloads global model settings; explicit SDK `rin.chat.runTurn({ model, thinkingLevel })` values override the per-chat defaults for that turn. Chat slash commands are control paths, not prompt turns, and are suppressed when the chat is `record_only`.

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

- quote replies use a structured quote part with the exact platform `messageId`; quote is not a separate payload metadata field;
- reply ids in storage indexes and delivery routing are derived projections of that quote node, while legacy records are migrated at read boundaries;
- native mentions use the exact platform user id;
- files/images use local paths or recipient-accessible URLs;
- generated image/file delivery uses rich-object syntax such as `[image: preview](local-path)` or structured SDK `parts`;
- recipient-visible attachment delivery is proven by outbox/platform result or a stored delivery record;
- an SDK send result with `delivered: false, pending: true` means the adapter accepted asynchronous dispatch but final delivery remains unknown; verify the returned `outboxId` instead of reporting delivery success.

## Stored chat context

`chat.sqlite` is the single durable authority for chat messages and execution state:

```text
<agentDir>/data/chat/chat.sqlite
```

For a normal agent install, `<agentDir>` is usually `~/.rin`. Session JSONL remains under the ordinary session layout and is not stored in this database.

The main tables are:

- `messages`: normalized inbound and delivered assistant messages;
- `chat_state`: per-chat sequence, reset generation, and authoritative session binding;
- `inbound_heads`: the latest provider recovery cursor per bot/chat without scanning message history;
- `turns`: inbox classification, retry, lease, fencing, supersession, and terminal ownership;
- `outbox`: logical outgoing messages and post-delivery actions;
- `outbox_deliveries`: ordered delivery fragments, attempts, provider message ids, and ambiguous outcomes.

The plain text log projection remains at `data/chat/message-store/chat-log-view/<platform>/<botId>/<chatId>/<YYYY-MM-DD>.txt`. EvalBridge audit records remain at `data/chat/eval/<YYYY-MM-DD>.jsonl`. Neither projection owns execution or recovery state.

Lookup contract:

1. Known `chatKey` and `messageId`: use `rin.chat.messages.get({ chatKey, messageId })`; bounded chronological reads use `rin.chat.messages.list(...)` with message-id cursors.
2. For direct read-only diagnosis with only a `messageId`, query the `messages_message_id_idx` index and preserve `received_at, record_key` order.
3. Known `chatKey` and date: query by `chat_key` and the local date range using `messages_chat_date_idx`.
4. Inbox, recovery, and delivery diagnosis must query `turns`, `inbound_heads`, `outbox`, or `outbox_deliveries`; do not infer control state by scanning message history.
5. Treat direct database access as read-only diagnosis. Runtime writes must use the owning chat APIs so transactions, generations, and fencing stay intact.
6. An inbound quote node contains only the referenced message id. Resolve it with `rin.chat.messages.get({ chatKey, messageId })` only when the current request depends on that context; inspect the retrieved message's rich elements and follow its nested quote node only as far as needed.

Install and update own every Chat authority migration. Before restarting the daemon, the installer stops the old runtime, rewrites legacy chat keys, creates or upgrades `chat.sqlite`, transactionally imports legacy message/inbox/outbox authority, imports legacy `state.json` session bindings, and archives old control directories under `data/chat/legacy-migrated-v1/`. Invalid or incomplete legacy data fails the install/update instead of starting a partially migrated runtime. Runtime database opens only validate the current schema and never import legacy authority or upgrade an old schema; an unmet migration therefore degrades Chat while the core daemon remains available. Migration retries serialize through SQLite, and a crash after import reimports any pre-archive legacy writes before completing the one-way archive.

## Troubleshooting contract

1. Preserve the exact visible symptom: platform, chat key, message id, text, attachment, command, error, timestamp, and expected behavior.
2. Locate the first producer boundary: adapter connection, inbound normalization, message store, inbox queue, controller command path, frontend turn driver, daemon worker, outbox, platform send path, or renderer.
3. Inspect that boundary with SDK reads, read-only chat database queries, adapter-local probes, or `rin status --json`.
4. Add or run the smallest focused test for source changes.
5. Report the producer boundary, evidence, and remaining runtime/deploy step.

Common boundary checks:

- **Message stored but turn idle:** inspect `turnPolicy`, trust/allow rules, inbox state, active turn state, and controller errors.
- **Record-only chat idle:** confirm the scheduled task/background producer that reads stored messages.
- **Slash command mismatch:** command acknowledgements are config/i18n output; verify the command path switched sessions for `/new`.
- **OneBot/QQ after NapCat relogin:** separate platform login from Rin bridge connectivity; check Rin runtime status, WebSocket connection, and an adapter-level login probe.
- **Outbound text queued:** inspect the outbox quote part, platform error, and message-store accepted/processed state.
- **Attachment missing:** verify the file exists, rich-object or structured `parts` attachment was sent, and the adapter produced a delivery result.
- **Config change idle:** confirm the active `~/.rin/settings.json`, adapter entries, runtime reload/restart, and running app path.
