# Execution Environment

This document orients agents that are running inside Rin.

## Agent, not chatbot

When you run inside Rin, you are an agent rather than a plain chatbot.

That means you are expected to do useful work during a turn when the user asks for it, not only describe what a user could do manually. Depending on the active runtime and configured capabilities, you may be able to:

- inspect files and directories
- run shell commands
- edit or create files
- search the web or fetch a URL
- recall archived session history
- manage self-improvement prompts and skills
- delegate isolated work to a subagent
- create or inspect scheduled tasks
- interact with configured chat bridges

The current tool list and system prompt are authoritative for what is actually available in a given turn. Do not assume a capability exists just because it is described here; verify the live tool list and relevant docs.

## Agent loop

A user input starts an agent loop.

During the loop, you can read context, use tools, modify state when appropriate, validate results, and then send one final response. After the final response is sent, that loop is complete. You will not keep acting in that same loop until the user sends another input or an explicitly scheduled/background mechanism triggers a new turn.

Implications:

- finish concrete work before the final response when the request is clear and safe
- do not promise that you will keep working after the final response unless you created or verified a scheduled/background process
- if you need more information before acting, ask before making irreversible changes
- report completed work, validation, and blockers in the final response

## Inspecting the current environment

The current environment is the environment where this agent process and its tools run. It may be a daemon worker, a subagent, a container, a VM, or a remote machine.

Useful starting checks:

```sh
pwd
whoami
hostname
uname -a
env | grep -E '^(RIN_DIR|PI_AGENT_DIR|HOME|SHELL|PATH)='
```

For Rin-specific state, prefer stable runtime paths and commands:

```sh
rin status
rin status --json
rin usage
```

Useful stable paths include:

- `~/.rin/docs/rin/`: Rin-specific agent docs
- `~/.rin/docs/pi/`: upstream Pi reference docs installed with Rin
- `~/.rin/settings.json`: Rin / Pi settings
- `~/.rin/sessions/`: session records
- `~/.rin/memory/`: memory data
- `~/.rin/self_improve/`: self-improvement prompts and skills
- `~/.rin/app/current/`: current installed runtime entrypoint for audit or emergency repair

When operating in a repository or project, also inspect the local project state before acting:

```sh
git status --short
git branch --show-current
git rev-parse --show-toplevel
```

Then read the local README, project instructions, package scripts, or CI config before choosing validation commands.

Avoid printing secrets from `auth.json`, environment variables, credentials files, browser profiles, or service configs. Inspect only the minimum needed fields and redact sensitive values in user-facing output.

## Self-improvement and traceable memory

Rin is a self-improving, memory-capable agent environment.

Relevant state may exist across turns and sessions:

- archived conversation/session recall through memory tools
- always-on self-improvement prompt baselines under `~/.rin/self_improve/prompts`
- reusable procedures and playbooks under `~/.rin/self_improve/skills`
- session files under `~/.rin/sessions/`
- scheduled tasks and daemon state under `~/.rin/data/`

Not all stored state is injected into every prompt. If past work matters, search memory or inspect the relevant stored files instead of assuming the current context is complete.

When saving durable learning, prefer the right storage target:

- stable identity, baseline preferences, and compact operating facts belong in self-improvement prompts
- reusable procedures, checklists, examples, and workflows belong in skills
- transient task progress belongs in the current session or a task-specific work file, not in always-on prompts

## This may not be the user's own environment

The machine or account you can access may not be the machine or account the user is personally operating.

Examples:

- in chat bridge turns, the sender is a chat-platform user, not necessarily the local shell user
- a daemon worker may run under a dedicated service account
- a subagent may run with a different working directory or reduced context
- browser, GUI, phone, or remote-server state may live on another host
- a project checkout may be a temporary clone rather than the user's canonical workspace

Before making assumptions about files, installed software, network access, browser login state, devices, or ownership, verify the live environment. If the user asked for work on a specific host, chat, repository, account, or device, confirm that your current tools are pointed at that target before changing state.
