# Diagnostic and Status Commands

Use this document when an agent needs Rin health, session work state, subscription/API usage, or self-improve history.

These commands have two surfaces:

- **Frontend view:** default human-readable output. Use it when the owner asks to look at the current state quickly.
- **Backend view:** structured or filterable output for agents. Use it for self-diagnosis, automation, and evidence gathering before claims or repairs.

## Command responsibilities

| Command            | Owns                                                                                                        | Frontend view                                                                                 | Backend view                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `rin doctor`       | Whole Rin health: daemon socket, managed service, chat bridge readiness, worker count, and service logs.    | `systemctl`-style health page plus recent logs.                                               | `rin doctor --json` returns the complete health snapshot.                                                             |
| `rin status`       | Session work state: currently running and already-ended daemon work, workers, and scheduler activity.       | Running sessions only, formatted for quick reading; `--watch` refreshes it.                   | `rin status --json`, RPC `daemon_activity`, or SDK `rin.daemon.activity()` returns the full daemon activity snapshot. |
| `rin usage`        | Subscription/API usage: provider quota, token/cost history, remaining windows, reset times, and aggregates. | Codex-like quota and recent 5h/1d/7d usage summary.                                           | Filterable reports through `--from`, `--to`, `--group-by`, `--filter`, `--events`, `--dimensions`, `--include-zero`.  |
| `rin self-improve` | Self-evolution usage: distillation outcomes, changed artifacts, failures, and historical stats.             | Resume-list-like list of all self-improve outcomes from the past 1 day; `--id` shows details. | `rin self-improve --json` plus filters returns complete records and stats.                                            |

`memory` is not the self-evolution command name. In Rin terminology, memory means original evidence and retrieval. Use `rin self-improve` for distilled self-improve activity.

## `rin doctor`

Use `doctor` when the question is whether Rin itself is healthy.

Frontend:

```sh
rin doctor
```

Backend:

```sh
rin doctor --json
```

Backend output includes:

- target user, install dir, socket path, and socket readiness;
- service manager and captured managed-service status/journal lines when available;
- daemon status, worker status, and chat bridge status when the socket answers.

Use this backend output for self-repair triage. If daemon socket state and service logs disagree, treat the installed runtime/service boundary as unresolved and inspect `docs/runtime-layout.md` before changing state.

## `rin status`

Use `status` when the question is what Rin sessions or scheduled work are doing.

Frontend:

```sh
rin status
rin status --watch
```

Backend CLI:

```sh
rin status --json
rin status --json --limit 100 --offset 0
```

RPC:

```json
{ "id": "agent-status-1", "type": "daemon_activity" }
{ "id": "agent-sessions-1", "type": "list_sessions", "limit": 100, "offset": 0 }
```

SDK:

```js
const activity = await rin.daemon.activity();
const status = await rin.daemon.status();
const sessions = await rin.sessions.list({ limit: 100, offset: 0 });
```

Use `rin status --json` for the combined backend snapshot: daemon activity plus a session listing page. Use `daemon_activity` / `rin.daemon.activity()` for live workers and scheduled-task activity. Use `list_sessions` / `rin.sessions.list()` when ended or detached session records matter. Use `daemon_status` / `rin.daemon.status()` when daemon health extras such as chat bridge status also matter.

## `rin usage`

Use `usage` when the question is subscription/API consumption, quota, reset time, token history, or grouped cost/token stats.

Frontend:

```sh
rin usage
```

The default view shows configured accounts/quota and the recent 5h, 1d, and 7d token/cost summary.

Backend examples:

```sh
rin usage --dimensions
rin usage --json
rin usage --json --events --from 24h --limit 100
rin usage --json --group-by provider_model,capability --from 7d
rin usage --group-by session,capability --filter provider=openai-codex --from 30d
rin usage --group-by hour --from 1d --include-zero
```

Supported time forms include ISO timestamps, `YYYY-MM-DD`, and relative values such as `30m`, `5h`, `7d`, and `4w`.

Use `--json` when an agent needs quota plus the queried history/statistics in one backend payload. Text backend reports remain available for quick aggregate/event tables. Use filters for exact dimensions only after checking `rin usage --dimensions`.

## `rin self-improve`

Use `self-improve` when the question is what Rin changed or learned through self-evolution.

Frontend:

```sh
rin self-improve
rin self-improve --id <run-id>
```

The default view lists every self-improve outcome from the past 1 day. `--id` prints the detailed record, changed files, notes, and output preview for one run.

Backend:

```sh
rin self-improve --json
rin self-improve --json --from 30d --status failed
rin self-improve --json --trigger periodic_review --limit 100
rin self-improve --json --id <run-id>
```

Backend output includes generated time, filters, stats, and the matching maintenance-history records. Use it for historical analysis, failure review, and self-improve usage statistics.

## Choosing CLI, RPC, or SDK

- Use the **CLI backend** when the command reads local files, token usage DBs, service logs, or needs complex filters.
- Use **RPC** when a running frontend/agent needs daemon state without spawning a subprocess. Current shared RPC commands for this surface are `daemon_activity`, `daemon_status`, and `list_sessions`.
- Use the **Agent SDK** in Node scripts when composing daemon-backed checks with task/chat operations.
- Do not infer self-improve history from memory recall. Read `rin self-improve --json` for structured self-improve history, and use `recall` only for original transcript evidence.

## Reporting contract

When reporting from these commands, name:

- command and backend/frontend mode used;
- time range and filters, if any;
- key state observed;
- whether the evidence came from CLI output, RPC, SDK, service logs, or the usage/self-improve store;
- remaining boundary before changing source, installed runtime, tasks, or chat adapters.
