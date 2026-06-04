# Execution Environment

Use this document to orient a turn running inside Rin.

Execution-environment work is a turn-target contract. The agent identifies where the current tools run, which capabilities are live, which external target the user intends, and what validation proves the result.

## Prompt brief

Target surface:

- current Rin agent turn;
- live tool registry and system prompt;
- shell/daemon/browser/chat/repository/remote host reached by the current tools;
- installed Rin docs and persistent state surfaces.

Goal:

- align the live execution environment with the user's intended target before changing or reporting state.

Trusted inputs:

- current system prompt and live tool list;
- `pwd`, `whoami`, `hostname`, OS, environment variables, and process context;
- `rin status`, `rin status --json`, and `rin usage`;
- repository state and local project instructions for source work;
- target-specific docs named by this page and adjacent topic docs.

Output contract:

- current execution host/user/cwd when relevant;
- live capability surface used;
- intended target and any mismatch resolved;
- validation command or evidence path;
- final state, blocker, or next boundary.

## Success criteria

A turn is environment-aligned when:

- live tools and current system prompt define the capability surface;
- shell, daemon, repository, browser, chat, or remote target identity is known for the work being performed;
- installed Rin docs are used for Rin behavior and Pi docs are routed through `docs/pi-overrides.md`;
- source checkout work and installed-runtime work are treated as separate targets;
- final reporting names the validation performed and the state observed.

## Runtime identity contract

Inside Rin, the assistant is an LLM inside an agent runtime. Rin owns the loop, live tool registry, session state, installed docs, configured agent directory, memory and skill surfaces, scheduled tasks, and chat bridges.

Keep these runtime facts active:

- the live system prompt and live tool list define available capabilities for the current turn;
- Rin docs describe the installed runtime layer;
- upstream Pi docs supply base behavior through the override contract in `docs/pi-overrides.md`;
- the current shell, daemon worker, browser, chat account, repository, or remote host may differ from the user's intended personal machine or target account.

## Turn boundary contract

A user input starts one bounded Rin agent loop. During that loop, use available tools, inspect state, make authorized changes, validate results, and send one final response.

Work that continues after the final response needs an inspectable producer: scheduled task, background service, or delegated non-interactive run.

A final response reports:

- completed work;
- validation performed;
- current state;
- blocker or remaining decision.

## Live capability contract

Use the current tool list as the source of truth. Rin installations may provide tools for file I/O, shell commands, editing, web search or URL fetch, archived session recall, self-improvement storage, non-interactive child runs, scheduled-task operations, and chat bridge operations.

Documentation examples describe possible capability surfaces. The live tool list proves availability for the current turn.

Read `docs/capabilities.md` for the installed capability index.

## Environment inspection contract

The current environment is where this agent process and its tools run: daemon worker, non-interactive CLI run, container, VM, local host, or remote machine.

Useful starting checks:

```sh
pwd
whoami
hostname
uname -a
env | grep -E '^(RIN_DIR|PI_AGENT_DIR|HOME|SHELL|PATH)='
```

Rin runtime checks:

```sh
rin status
rin status --json
rin usage
```

Stable Rin paths:

- `~/.rin/docs/rin/`: Rin-specific agent docs.
- `~/.rin/docs/pi/`: upstream Pi reference docs installed with Rin.
- `~/.rin/settings.json`: Rin/Pi settings.
- `~/.rin/sessions/`: session records.
- `~/.rin/memory/`: memory evidence and retrieval data.
- `~/.rin/self_improve/`: distilled self-improve guidance, prompts, skills, and indexes.
- `~/.rin/app/current/`: current installed runtime entrypoint.

For repository work, inspect project state before choosing validation commands:

```sh
git status --short
git branch --show-current
git rev-parse --show-toplevel
```

Then read local project instructions, package scripts, hook config, and CI config that apply to the intended repository.

## Persistent state contract

Rin state can outlive the current turn. Use the state surface that matches the question:

- memory evidence and recall through archived transcripts, memory tools, and session files;
- distilled self-improve prompt baselines under `~/.rin/self_improve/prompts`;
- reusable self-improve skills under `~/.rin/self_improve/skills`;
- scheduled tasks and daemon state under `~/.rin/data/`;
- managed sessions under `~/.rin/sessions/managed/`.

When past work matters, search memory or inspect the relevant original files. Store new distilled guidance in the narrowest fitting self-improve surface:

- baseline identity, preferences, and compact operating facts in prompt baselines;
- reusable procedures, examples, and workflows in skills;
- transient task progress in the active session or a task-specific work file.

Use `docs/memory-layering.md` and `docs/self-improve-distillation.md` for destination choice and distillation work.

## Target alignment contract

Before changing state, align the live tool target with the user's intended target.

Common target boundaries:

- chat bridge sender identity and platform chat;
- daemon worker account and service environment;
- non-interactive child session, working directory, and model;
- browser, GUI, phone, or remote-server host;
- repository root, branch, worktree, and canonical workspace;
- installed runtime path behind `~/.rin/app/current/`.

For tasks tied to a specific host, chat, repository, account, browser profile, device, or service, verify that the current tools point at that target before modifying files or state.

## Validation contract

Choose validation that proves the target state:

- command output, file diff, or test result for repository/source work;
- `rin status --json` for daemon, scheduled task, worker, or runtime liveness;
- message store, SDK result, adapter result, or platform evidence for chat work;
- screenshot, DOM assertion, file artifact, or app state for browser/desktop work;
- manifest, service file, and `app/current/` target for installed-runtime work.

Report the validation source and the observed state. For multi-step work, keep the current branch checklist updated through the `todo` tool when available.

## Read next

- Rin-over-Pi authority resolution: `docs/pi-overrides.md`.
- Installed runtime files and manifests: `docs/runtime-layout.md`.
- Capability index: `docs/capabilities.md`.
- Session/process/worktree overlap: `docs/session-awareness.md`.
- Non-interactive child runs: `docs/non-interactive-cli.md`.
