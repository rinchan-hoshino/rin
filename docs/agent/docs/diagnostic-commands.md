# Diagnostic and Status Commands

Use this document when an agent needs Rin health, session work state, or self-improve history.

These commands have two surfaces:

- **Frontend view:** default human-facing output. For `status` and `self-improve`, this is an interactive list TUI on a terminal; use `--once` for a static text snapshot.
- **Backend view:** structured or filterable output for agents. Use it for self-diagnosis, automation, and evidence gathering before claims or repairs.

## Command responsibilities

| Command            | Owns                                                                                                    | Frontend view                                                                              | Backend view                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `rin doctor`       | Whole Rin health: daemon socket, managed service, chat bridge, workers, recall index, and service logs. | `systemctl`-style health page plus recent logs.                                            | `rin doctor --json` returns the complete health snapshot.                                                             |
| `rin status`       | Session work state: currently running daemon workers and scheduler activity.                            | Pi-resume-list-style live TUI; `--once` prints a static snapshot.                          | `rin status --json`, RPC `daemon_activity`, or SDK `rin.daemon.activity()` returns the full daemon activity snapshot. |
| `rin self-improve` | Self-evolution usage: distillation outcomes, changed artifacts, failures, and historical stats.         | Pi-resume-list-style TUI over recent self-improve runs; `--once`/`--id` print static text. | `rin self-improve --json` plus filters returns complete records and stats.                                            |

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
- daemon status, worker status, and chat bridge status when the socket answers;
- a lightweight, read-only recall-index check covering the schema marker, SQLite metadata, rebuild flag, and stale dirty-writer markers.

A `memoryIndex.status` of `degraded` means recall indexing needs recovery; it does not mean the canonical transcript archive is absent. Normal recall performs dirty-marker/query-time synchronization. Use `rin memory-index repair` only when that recovery cannot restore the derived index.

Use this backend output for self-repair triage. If daemon socket state and service logs disagree, treat the installed runtime/service boundary as unresolved and inspect `docs/runtime-layout.md` before changing state.

## `rin status`

Use `status` when the question is what Rin sessions or scheduled work are doing.

Frontend:

```sh
rin status
rin status --once
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

Use plain `rin status` in a terminal for the live interactive list. Use `rin status --once` when output is piped or a static text snapshot is needed. Use `rin status --json` for the combined backend snapshot: daemon activity plus a session listing page. Use `daemon_activity` / `rin.daemon.activity()` for live workers and scheduled-task activity. Use `list_sessions` / `rin.sessions.list()` when ended or detached session records matter. Use `daemon_status` / `rin.daemon.status()` when daemon health extras such as chat bridge status also matter.

Codex quota is optional rather than a Rin core diagnostic. When the first-party `codex-usage` Pi package extension is installed, use `/usage` in TUI or Chat Bridge. It reports only Codex quota and does not create a telemetry database or chart.

## `rin self-improve`

Use `self-improve` when the question is what Rin changed or learned through self-evolution.

Frontend:

```sh
rin self-improve
rin self-improve --once
rin self-improve --id <run-id>
```

The default view opens an interactive list of recent self-improve outcomes from the past 1 day. Use ↑/↓ or j/k to move, Enter/Space to expand details, and q/Ctrl+C to exit. `--once` prints a static text snapshot. `--id` prints the detailed record, changed files, notes, and output preview for one run.

Backend:

```sh
rin self-improve --json
rin self-improve --json --from 30d --status failed
rin self-improve --json --trigger periodic_review --limit 100
rin self-improve --json --id <run-id>
```

Backend output includes generated time, filters, stats, and the matching maintenance-history records. Use it for historical analysis, failure review, and self-improve usage statistics.

## Choosing CLI, RPC, or SDK

- Use the **CLI backend** when the command reads local files, service logs, or needs complex filters.
- Use **RPC** when a running frontend/agent needs daemon state without spawning a subprocess. Current shared RPC commands for this surface are `daemon_activity`, `daemon_status`, and `list_sessions`.
- Use the **Agent SDK** in Node scripts when composing daemon-backed checks with task/chat operations.
- Do not infer self-improve history from memory recall. Read `rin self-improve --json` for structured self-improve history, and use `recall` only for original transcript evidence.

## Reporting contract

When reporting from these commands, name:

- command and backend/frontend mode used;
- time range and filters, if any;
- key state observed;
- whether the evidence came from CLI output, RPC, SDK, service logs, or the self-improve store;
- remaining boundary before changing source, installed runtime, tasks, or Chat platforms.
