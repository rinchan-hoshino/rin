# Non-interactive CLI

Use Pi-style non-interactive CLI when isolated work would make the current turn cleaner, safer, or faster. Invoke `rin -p` for final-text output, or add `--mode json` to return a result object. Pass a focused self-contained prompt, then integrate the returned result into the current turn.

## When to delegate

Use a non-interactive child run proactively when the task has an independent workstream, such as:

- scouting an unfamiliar code area while the parent keeps the main plan clean;
- running a context-free review, audit, or proofreading pass;
- comparing two implementation options in parallel;
- doing a narrow reproduction, log inspection, or verification pass;
- drafting a bounded artifact that the parent will review and integrate.

Do not delegate simple linear work, owner-visible confirmations, account operations, restarts, publishing, or irreversible actions. The parent agent remains responsible for final decisions, edits it accepts, validation, and the owner-facing report. Treat child runs as separate model calls: do not pass secrets, credentials, private logs, or sensitive chat context unless the current task explicitly authorizes that provider/data boundary.

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
- `--mode json`: print a JSON result object instead of only final text; it still needs `-p`, stdin, or another non-interactive trigger.
- `--provider <name>` and `--model <provider/model>`: select a model for this run.
- `--thinking <off|minimal|low|medium|high|xhigh>`: set thinking level.
- `--session <file>`: continue an existing dedicated session file.
- `--managed-session <leaf>`: create and keep a new session under `~/.rin/sessions/managed/<leaf>/`.
- `--name <name>`: set the child session display name.
- `--chat-key <chatKey>`: also deliver the final answer to a chat.
- `--timeout <seconds>`: override the default 30 minute wait.

Runs without `--session` or `--managed-session` are transient: Rin creates a temporary session under `sessions/managed/cli/` and removes it after the turn. When delegated work needs durable context across runs, use `--managed-session subagent` on the first run, capture the returned `sessionFile` with `--mode json`, then continue it with `--session <file>`.

## Subagent delegation pattern

By default, make child runs read-only scouts or reviewers. Let the parent apply accepted patches, or give a writing child its own worktree/branch so parallel children do not edit the same files.

Create a kept child session under a managed subdirectory instead of the root session directory:

```sh
rin --mode json --managed-session subagent --name "Scout auth" -p \
  "You are a read-only scout. Map the auth code paths, list key files, and end with concise findings plus next checks."
```

Continue the returned session when useful:

```sh
rin -p --session /home/rin/.rin/sessions/managed/subagent/<returned>.jsonl \
  "Continue from your previous scout result and verify the JWT validation path."
```

For parallel independent children, launch a small bounded batch and write each output to a temp file. Keep normal concurrency to 2–3 children, set a timeout when the task may hang, and do not broaden network or write permissions beyond the child prompt:

```sh
rin --mode json --managed-session subagent --name "Audit API" -p "Audit API error handling" > /tmp/api-audit.json &
rin --mode json --managed-session subagent --name "Audit UI" -p "Audit UI error handling" > /tmp/ui-audit.json &
wait
```

## Prompt shape for child runs

Give the child enough context to act without reading the parent transcript:

- role and boundary: scout, reviewer, verifier, or isolated implementer; default read-only unless edits are explicitly safe;
- exact objective and acceptance criteria;
- repository or working directory, important files, and commands already run;
- allowed commands and validation budget;
- required output shape: summary, evidence, files touched/read, blockers, next steps.

Prefer concise structured output over a long transcript. Treat child output as external evidence: inspect it, verify important claims, and merge only the parts that survive parent review.

## Chat delivery

Use `--chat-key` to deliver the final answer to a chat while still printing it locally. This is an outward message, so use it only when the user authorized that delivery target and the chatKey is verified:

```sh
rin -p --chat-key telegram/123:-100456 "Write a short status update"
```

Chat delivery uses a detached one-shot chat controller. Delivered messages are not bound to a conversation session, so replies to those messages do not enter the non-interactive run's session. Do not use chat delivery for confirmations, account operations, publishing, restarts, or irreversible actions unless the user explicitly requested that exact outbound message.

## Agent guidance

Use non-interactive CLI when the work benefits from isolation, scripting, a separate context window, a different model, or chat delivery. Keep child sessions under `sessions/managed/<kind>/`, not the root session directory. Include the full task definition, necessary file references, and any required commands. Treat all returned output as an external result rather than shared memory.
