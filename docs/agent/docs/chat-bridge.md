# Chat Bridge Workflows

Rin bridges chat platforms through a framework-neutral chat runtime. Chat bridge work is no longer exposed as a general `chat_bridge` model tool. Use documented SDK, configuration, message-store, or platform-adapter workflows from normal file and shell tools instead.

## Built-in direct runtime adapters

The built-in direct runtime currently includes:

- Telegram
- OneBot
- QQ
- Feishu / Lark
- Discord
- Slack
- Minecraft / QueQiao

## When to use which path

- Use `/chat` in the TUI to configure official built-in adapters.
- Use adapter configuration under `settings.json -> chat` for scripted setup of built-in adapters.
- Use the chat runtime/adapter SDK from a script when you need live platform actions such as sending, replying, reacting, moderation, or platform API lookup.
- Read the local message store directly when you only need already stored chat context.
- Update saved identity/trust data through the documented identity store or SDK path instead of a model tool.

## Rich message parts

Rin chat rich content uses structured parts or Markdown rich-object syntax. Supported rich intents include:

- text / markdown
- native mention by exact platform user id
- quote / reply by exact platform message id
- image / file / video / audio / sticker by local path or URL

Native mentions require exact platform user ids. Raw `@name` text is visible text only.

## Stored chat context

For plain inspection of already stored chat records, read the local message store directly with `read` or `bash`.

Normal installs store chat records under:

```text
<agentDir>/data/chat-message-store/
```

Replace `<agentDir>` with the active Rin agent directory, usually `~/.rin`.

Useful paths:

- records: `data/chat-message-store/records/<first-two-record-key-chars>/<recordKey>.json`
- message-id index: `data/chat-message-store/indexes/by-message-id/<first-two-index-key-chars>/<indexKey>.json`
- chat/date index: `data/chat-message-store/indexes/by-chat-date/<platform>/<botId-if-present>/<chatId>/<YYYY-MM-DD>.json`

Cookbook:

1. known `chatKey` and `messageId`: compute the record key, then read the matching record JSON
2. known `messageId` only: read the message-id index, then read each relative record path it lists
3. known `chatKey` and date: read the chat/date index, then read the listed record keys and sort by `receivedAt` / `processedAt`

When both `chatKey` and `messageId` are known, the record key is SHA-1 of `chatKey + "\n" + messageId`:

```sh
agent_dir="${RIN_AGENT_DIR:-$HOME/.rin}"
chat_key='onebot/2301401877:1067390680'
message_id='1234567890'
record_key=$(node -e 'const crypto=require("crypto"); const [chatKey,messageId]=process.argv.slice(1); console.log(crypto.createHash("sha1").update(`${chatKey}\n${messageId}`).digest("hex"));' "$chat_key" "$message_id")
record_path="$agent_dir/data/chat-message-store/records/${record_key:0:2}/$record_key.json"
```

When only `messageId` is known, read the message-id index first; it contains relative record paths:

```sh
agent_dir="${RIN_AGENT_DIR:-$HOME/.rin}"
message_id='1234567890'
index_key=$(node -e 'const crypto=require("crypto"); console.log(crypto.createHash("sha1").update(process.argv[1]).digest("hex"));' "$message_id")
index_path="$agent_dir/data/chat-message-store/indexes/by-message-id/${index_key:0:2}/$index_key.json"
```

When listing one chat/date, read the chat/date index to get `recordKeys`, then read the matching record files.
