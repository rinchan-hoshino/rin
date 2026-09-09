# Chat bridge

A chat route binds one transport chat to one existing agent session. Output mirroring is explicit.

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

Codex can explicitly auto-bind by creating a task. Claude Code, pi, and OpenCode require an existing native session ID in the binding. Each CLI adapter serializes turns for a session and returns a receipt when the real child process starts. Its final stdout becomes the final public answer after a successful exit.
