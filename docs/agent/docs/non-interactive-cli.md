# Non-interactive CLI

Use non-interactive CLI for isolated child runs that make the current turn cleaner, safer, or faster. The parent agent defines the task, launches the child, reviews the result, and integrates only the parts that survive parent verification.

## Delegation contract

Use a child run for workstreams with a clear boundary:

- scout an unfamiliar code area;
- review or audit a diff, prompt, document, log, or plan;
- compare independent implementation options;
- reproduce or inspect a narrow issue;
- run an isolated verification pass;
- draft a bounded artifact for parent review.

The parent lane owns final decisions, accepted edits, validation, owner-visible confirmations, outward messages, source-control writes, account actions, restarts, publishing, and irreversible side effects. A child lane may own one of those boundaries only when the owner explicitly authorizes that delegation.

Treat child output as external evidence. Inspect claims, verify important details, and merge the useful result into the current turn.

## Basic invocation

Print final text:

```sh
rin -p "Summarize this repository"
```

Return a JSON result object:

```sh
rin --mode json -p "Map the auth code paths and return findings as bullets"
```

Pipe stdin into the child prompt:

```sh
cat README.md | rin -p "Summarize this text"
git diff | rin -p "Review this diff and list risky changes"
```

Include file content with `@file` arguments:

```sh
rin -p @prompt.md "Apply these instructions to the current repository"
```

Useful options:

- `-p`, `--print`: run one non-interactive turn and print the final answer.
- `--mode json`: print a JSON result object; still pair it with `-p`, stdin, or another non-interactive trigger.
- `--provider <name>` and `--model <provider/model>`: select a provider or model.
- `--thinking <off|minimal|low|medium|high|xhigh>`: set thinking level.
- `--session <file>`: continue an existing session file.
- `--managed-session <leaf>`: keep a new session under `~/.rin/sessions/managed/<leaf>/`.
- `--name <name>`: set the child session display name.
- `--chat-key <chatKey>`: deliver the final answer to a verified chat target.
- `--timeout <seconds>`: set the maximum wait time.

Runs without `--session` or `--managed-session` are transient. Use a managed session when the child needs durable context across runs.

## Managed child sessions

Create a kept child session under a managed subdirectory:

```sh
rin --mode json --managed-session subagent --name "Scout auth" -p \
  "You are a read-only scout. Map the auth code paths, list key files, and end with concise findings plus next checks."
```

Continue the returned `sessionFile` when useful:

```sh
rin -p --session /home/rin/.rin/sessions/managed/subagent/<returned>.jsonl \
  "Continue from your previous scout result and verify the JWT validation path."
```

For parallel independent children, launch a small bounded batch, set timeouts for work that may hang, and write each result to a file the parent can inspect:

```sh
rin --mode json --managed-session subagent --name "Audit API" -p "Audit API error handling" > /tmp/api-audit.json &
rin --mode json --managed-session subagent --name "Audit UI" -p "Audit UI error handling" > /tmp/ui-audit.json &
wait
```

Give writing children their own worktree or branch. Use read-only prompts for scouts and reviewers.

## Child prompt shape

Make the child prompt self-contained. Include:

- role and boundary: scout, reviewer, verifier, or isolated implementer;
- objective and acceptance criteria;
- repository or working directory;
- important files, commands already run, and evidence to inspect;
- allowed commands and validation budget;
- output shape: summary, evidence, files read or touched, blockers, and next checks.

Prefer structured output over a copied parent transcript. Pass secrets, credentials, private logs, or sensitive chat context only when the current task explicitly authorizes that provider/data boundary.

## Chat delivery

Use `--chat-key` when a child run should deliver its final answer to a verified chat target while also printing locally:

```sh
rin -p --chat-key telegram/123:-100456 "Write a short status update"
```

Chat delivery uses a detached one-shot chat controller. Delivered messages are not bound to the child session for later replies. Use this path for authorized outbound status messages. Keep confirmations and account actions in the parent lane.

## Parent integration

After a child run:

1. Read the final text or JSON result.
2. Inspect cited files, logs, commands, or evidence.
3. Apply only accepted edits or conclusions in the parent lane.
4. Run the parent validation gate for accepted changes.
5. Report child work as evidence reviewed by the parent, not as an automatic decision.
