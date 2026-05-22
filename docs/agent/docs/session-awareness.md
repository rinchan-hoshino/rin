# Session Awareness

Rin can run multiple agent sessions, workers, frontends, chat bridge turns, non-interactive CLI runs, and scheduled/background tasks at the same time. Your current turn is only one vantage point.

Use this guide when you need to know what other sessions did recently or are doing now, especially before editing shared files, claiming a task is idle, deleting worktrees, committing, rebasing, restarting services, or starting duplicate validation.

## What to check first

Start with low-risk inventory commands:

```sh
rin status
rin status --json
rin usage
find ~/.rin/sessions -maxdepth 3 -type f | sort | tail -40
ps -ef | grep -E 'rin|node|tsx|npm|git|gh' | grep -v grep
```

Then inspect the target project:

```sh
git status --short
git branch --show-current
git worktree list
git log --oneline --decorate -20
```

If a command shows another active or recent owner of the same boundary, pause before making changes. Read enough state to avoid racing it, then coordinate through the durable issue, task, worktree, or chat record.

## Find what other sessions did

Use the source that matches the age and precision you need:

- **Archived prior sessions:** use `search_memory` when you need original context, evidence, chronology, or why a decision exists. Leave the query empty to browse recent archived sessions if you do not know the search terms yet.
- **Recent stored sessions:** inspect `~/.rin/sessions/` when a session may be too recent to appear in memory or when you need the exact stored session file.
- **Chat-bound work:** read the relevant chat bridge docs and stored chat paths when platform replies, quotes, or chat-session binding matter.
- **Repository work:** inspect branches, worktrees, commits, uncommitted changes, and issue/PR comments before assuming a repository task is untouched.
- **Scheduled/background work:** inspect scheduled task state before saying work will or will not continue after this turn.

Do not treat memory summaries, old PRs, installed files, or a single worktree as complete proof. Prefer the freshest authoritative source for the boundary you are about to touch.

## Find what other sessions are doing now

Use live state for active work:

- `rin status` / `rin status --json` for daemon and runtime state
- `rin usage` for recent session/model activity
- process listings for running `rin`, `node`, `tsx`, `npm`, `git`, `gh`, test, build, or validation processes
- repository lock files, worktrees, and command output files for active source-control or validation work
- scheduled task state for queued, running, paused, recurring, or skipped background jobs

A running process is evidence to investigate, not automatically the root cause or owner. Check its command, working directory, logs/output, and related session/task record when available.

## How to avoid conflicts

When another session or process appears to own the same work:

1. Identify the boundary: repository, branch, worktree, issue/PR, chat, scheduled task, service, or runtime file.
2. Identify the freshest owner evidence: active process, session file, task record, issue/PR update, or recent commit.
3. Avoid duplicate writes. Do not edit the same files, rebase the same branch, delete the same worktree, kill the same process, or publish the same release unless the owner explicitly asked you to take over.
4. If takeover is needed, preserve evidence first: save logs, note process IDs, record branches/commits, and make rollback possible.
5. If the safe action is unclear, report the conflict and the exact state you found instead of guessing.

## Reporting session-aware findings

Keep reports short and actionable:

- what you checked
- what other session/process/task activity exists, if any
- whether it conflicts with the requested action
- what you changed or intentionally did not change
- what owner action or authority is needed, if any

Avoid dumping raw session files or logs. Quote only the minimum relevant lines and redact secrets.
