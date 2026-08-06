# Session Awareness

Use this document when the current turn may overlap with other Rin sessions, workers, chat turns, non-interactive child runs, scheduled/background tasks, processes, worktrees, or repository activity.

Session awareness is a coordination contract. The agent identifies the shared boundary, finds the freshest owner evidence, chooses one writer for that boundary, and reports the coordination state before acting on shared or long-lived state.

## Prompt brief

Target surface:

- Rin sessions and managed child sessions;
- daemon workers and scheduled/background tasks;
- chat-bound turns and message stores;
- OS processes and generated artifacts;
- repository branches, worktrees, commits, issues, and PRs;
- installed-runtime files and services.

Goal:

- prevent duplicate, stale, or conflicting writes by identifying the active owner and freshest authoritative state for the boundary being touched.

Trusted inputs:

- `rin status` / `rin status --json`;
- session files under `~/.rin/sessions/`;
- scheduled task records and liveness state;
- process lists, working directories, logs, and output files;
- repository status, branches, worktrees, commits, and remotes;
- platform metadata and stored chat records;
- archived memory for older decisions and wording.

Output contract:

- boundary checked;
- evidence surfaces inspected;
- active or recent owner found;
- coordination action chosen;
- final writer or intentionally separate lane;
- validation or next coordination step.

## Success criteria

Session-aware work is complete when:

- the shared boundary is named before mutation;
- recent and live owner evidence is checked for that boundary;
- the chosen action uses the freshest authoritative state;
- each write boundary has one responsible owner;
- final reporting names surfaces checked, owner state, conflict state, and action taken.

## Check triggers

Use session awareness before work that touches shared or long-lived state:

- editing repository files, rebasing, committing, pushing, or deleting worktrees;
- claiming work is idle, complete, blocked, or still running;
- starting duplicate validation, builds, tests, or background producers;
- pausing, resuming, completing, deleting, or replacing scheduled tasks;
- restarting services, updating installed runtimes, or changing daemon state;
- answering from earlier conversation context, chat history, or another session's work.

## Boundary inventory

Start with low-risk state discovery:

```sh
rin doctor
rin status
rin status --json
rin usage
rin self-improve
find ~/.rin/sessions -maxdepth 3 -type f | sort | tail -40
ps -ef | grep -E 'rin|node|tsx|npm|git|gh' | grep -v grep
```

For repository work:

```sh
git status --short
git branch --show-current
git worktree list
git log --oneline --decorate -20
```

Use these commands as an index. Follow up with the specific session file, task record, process working directory, log, commit, PR, or chat record that owns the boundary you are about to touch.

## Owner evidence map

Choose the evidence surface that matches the boundary:

- **Archived memory:** original wording, evidence, chronology, older decisions, and cross-session rationale.
- **Stored sessions:** recent exact session files and managed child-session records.
- **Live daemon state:** workers, scheduled tasks, active/running state, session listings, and redacted prompt/command metadata. Use `rin status --json`, RPC `daemon_activity` plus `list_sessions`, or SDK `rin.daemon.activity()` plus `rin.sessions.list()` for agent-readable state.
- **Processes:** command lines, working directories, logs, output files, and child-agent runs.
- **Repositories:** branches, worktrees, commits, locks, uncommitted changes, remotes, issues, and PR comments.
- **Scheduled/background tasks:** task records, active producer state, next run time, and last result/error.
- **Chat-bound work:** platform sender metadata, message ids, quote rich nodes, chat-session binding, and stored chat paths.
- **Installed runtime:** manifests, service files, `app/current/`, release metadata, and daemon liveness.

## Coordination contract

When another owner appears to touch the same boundary:

1. Name the boundary: repository, branch, worktree, issue/PR, chat, task, service, runtime file, or generated artifact.
2. Identify the freshest owner evidence: active process, session file, task record, log/output file, commit, PR comment, chat record, scheduler state, or service state.
3. Choose the coordinating action:
   - wait for the active owner;
   - read more state;
   - continue in a separate lane with a separate write boundary;
   - adopt the existing lane with authority;
   - report the conflict and stop at the coordination boundary.
4. Preserve useful coordination evidence: process IDs, log paths, branch names, commits, task IDs, worktree paths, or rollback points.
5. Assign one owner to each write boundary before making changes.

## Freshness contract

Use the freshest authoritative source for the boundary:

- live process and daemon state for active work;
- scheduler task record plus liveness check for background jobs;
- current worktree and remote branch state for source work;
- platform metadata and stored chat records for chat work;
- install manifest, service file, and `app/current/` for installed-runtime work;
- archived memory for older decisions, wording, and rationale.

Memory summaries, old PR comments, installed files, and a single checkout are leads. Promote a lead to authority only when it is the owning surface for the boundary.

## Common boundary contracts

### Repository/source work

Check `git status --short`, current branch, worktrees, recent commits, and remote branch state. For shared branches or PRs, inspect recent comments, checks, and pushes before editing or claiming status.

### Scheduled/background tasks

Read the task record and liveness state before pausing, resuming, completing, deleting, replacing, or claiming future work. Use `docs/scheduled-tasks.md` for task operations.

### Non-interactive child runs

Treat child output as evidence owned by the parent lane. Read child session files or JSON output, verify claims in the parent lane, then choose accepted edits or conclusions. Use `docs/non-interactive-cli.md` for delegation shape.

### Chat-bound work

Use platform metadata for sender identity, rich quote nodes for reply semantics, and stored chat records for message ids and chat-session binding. Use `docs/chat-bridge.md` for chat storage and adapter surfaces.

### Installed runtime work

Use `docs/runtime-layout.md` to identify the active installed runtime, target user, manifest, service, and `app/current/` before update, rollback, restart, or installed-file inspection.

### Exact recovery of omitted tool results

`old tool result omitted` is a provider-bound context marker, not a transcript mutation. When exact earlier output matters, use the tool result's structural `toolCallId` to stream the authoritative persistent session JSONL. This is an on-demand recovery path; do not add the procedure to the resident system prompt.

```bash
: "${PI_SESSION_FILE:?persistent session required}"
TOOL_CALL_ID='replace-with-structural-id'
node --input-type=module - "$PI_SESSION_FILE" "$TOOL_CALL_ID" <<'NODE'
import fs from "node:fs";
import readline from "node:readline";

const [sessionFile, wantedId] = process.argv.slice(2);
const lines = readline.createInterface({
  input: fs.createReadStream(sessionFile, { encoding: "utf8" }),
  crlfDelay: Infinity,
});
let found = false;
for await (const line of lines) {
  if (!line.trim()) continue;
  const entry = JSON.parse(line);
  const message = entry?.type === "message" ? entry.message : entry?.message;
  const role = String(message?.role || "");
  if (
    (role === "toolResult" || role === "tool_result") &&
    String(message?.toolCallId || "") === wantedId
  ) {
    const content = message.content;
    process.stdout.write(
      typeof content === "string" ? content : JSON.stringify(content),
    );
    found = true;
    break;
  }
}
if (!found) process.exitCode = 2;
NODE
```

For an ephemeral session where `PI_SESSION_FILE` is unset, there is no persistent transcript recovery surface; do not claim exact recovery succeeded.

## Report contract

Report session-aware findings in operational terms:

- boundary checked;
- surfaces inspected;
- active or recent owners found;
- conflict status;
- coordinating action taken;
- writer chosen or separate lane used;
- authority, blocker, or next coordination step.

Quote only the minimum relevant log/session lines needed to identify the boundary and owner.
