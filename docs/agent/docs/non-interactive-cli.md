# Non-interactive CLI

Use Pi-style non-interactive CLI when you need an isolated, scriptable agent turn outside the current conversation. Invoke `rin -p` for final-text output or `rin --mode json` for JSON output, pass a focused self-contained prompt, and integrate the returned result into the current turn.

## Basic usage

```sh
rin -p "Summarize this repository"
```

If stdin is piped, Rin enters non-interactive mode and merges stdin into the initial prompt, matching Pi's print-mode interface:

```sh
cat README.md | rin -p "Summarize this text"
git diff | rin -p "Review this diff and list the risky changes"
```

Use `@file` arguments to include file text in the initial prompt:

```sh
rin -p @prompt.md "Apply these instructions to the current repository"
```

Useful options:

- `-p`, `--print`: run one non-interactive turn and print the final answer.
- `--mode json`: print a JSON result object instead of only final text.
- `--provider <name>` and `--model <provider/model>`: select a model for this run.
- `--thinking <off|minimal|low|medium|high|xhigh>`: set thinking level.
- `--session <file>`: continue an existing dedicated session file.
- `--chat-key <chatKey>`: also deliver the final answer to a chat.
- `--timeout <seconds>`: override the default 30 minute wait.

Runs without `--session` do not keep a session. When delegated work needs durable context across runs, agents should create or reuse a dedicated session under `sessions/managed/<kind>/` and pass it with `--session`.

## Chat delivery

Use `--chat-key` to deliver the final answer to a chat while still printing it locally:

```sh
rin -p --chat-key telegram/123:-100456 "Write a short status update"
```

Chat delivery uses a detached one-shot chat controller. Delivered messages are not bound to a conversation session, so replies to those messages do not enter the non-interactive run's session.

## Agent guidance

Use non-interactive CLI when the work benefits from isolation, scripting, a separate context window, a different model, or chat delivery. Include the full task definition, necessary file references, and any required commands. Treat all returned output as an external result rather than shared memory.
