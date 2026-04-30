# Non-interactive CLI

Use Pi-style non-interactive CLI when you need an isolated, scriptable agent turn outside the current conversation. Invoke `rin -p` for final-text output or `rin --mode json` for JSON-line event output, pass a focused self-contained prompt, and integrate the returned result into the current turn.

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
- `--mode json`: print JSON-line events instead of only final text.
- `--provider <name>` and `--model <provider/model>`: select a model for this run.
- `--thinking <off|minimal|low|medium|high|xhigh>`: set thinking level.
- `--session <file>`: continue an existing session file.
- `--chat-key <chatKey>`: also deliver the final answer to a chat.
- `--bind-chat-session`: with `--chat-key`, use and update that chat's normal conversation session.
- `--timeout <seconds>`: override the default 30 minute wait.

New runs without `--session` create managed CLI sessions under `sessions/managed/cli/`.

## Chat delivery

Use `--chat-key` to deliver the final answer to a chat while still printing it locally:

```sh
rin -p --chat-key telegram/123:-100456 "Write a short status update"
```

By default, chat delivery uses a detached one-shot chat controller so it does not replace the chat's normal conversation session. Add `--bind-chat-session` when the run should use and update that chat's normal conversation session.

## Agent guidance

Use non-interactive CLI when the work benefits from isolation, scripting, a separate context window, a different model, or chat delivery. Include the full task definition, necessary file references, and any required commands. Treat all returned output as an external result rather than shared memory.
