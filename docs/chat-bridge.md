# Chat bridge

A chat route associates one transport chat with its own agent conversation. The guided setup creates that conversation when the first message is admitted and reuses it for later messages.

Supported transports are Discord, Telegram, and OneBot v11. OneBot can connect an ordinary QQ account. QQ's official Bot API is not supported.

## Admission

Every enabled transport has a non-empty `allowUsers` list. Ordinary messages are accepted in this order:

1. match the sender's stable user ID;
2. reject a matching `denyChats` rule;
3. require a matching `allowChats` rule when that list exists;
4. apply DM-only and group mention behavior;
5. require an explicit binding or supported auto-bind;
6. download media and persist the input.

A chat rule is either a chat ID string or `{"chatId":"…","topicId":"…"}`. Deny wins over allow. Registered commands require `allowUsers` but bypass chat allow/deny, DM-only, and mention rules. Commands never become agent input. The public built-in catalog contains `/help`; private command extensions may add more.

Telegram and OneBot may treat a group as private when a complete current member list proves that the agent and the current authorized owner are the only members. Positive results are rechecked. Incomplete or negative proofs do not grant access.

## Quiet delivery

`quiet.default` sets the default. `quiet.byRoute` overrides it with the same JSON route key used by bindings, such as `["telegram","123"]` or `["telegram","123","topic"]`.

Accepted true forms are `true`, `"quiet"`, `{"enabled":true}`, `{"quiet":true}`, and `{"mode":"quiet"}`. Quiet routes hide working, commentary, and summary messages. Final answers and errors still send. Inbound work still runs.

## Agent sessions

`autoBind` creates conversations for Codex, Claude Code, pi, and OpenCode. It specifies the workspace and an optional model. Each admitted chat or topic has an independent conversation; concurrent first messages share one creation operation. The association persists across restarts. An explicit binding can also connect an existing conversation.

Codex creates its thread through app-server. CLI adapters reserve a local route, start a fresh native session with the first input, and save the session reference from structured output. Later turns use that native reference and the original workspace. They serialize turns per conversation and return a receipt when the child process starts. A successful native completion produces the final public answer; reasoning and tool output stay in the agent.

An interrupted first run with no returned session reference remains unresolved until inspected. This state persists across restarts, preventing accidental duplicate conversations.
