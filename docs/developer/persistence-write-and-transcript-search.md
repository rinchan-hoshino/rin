# Persistence Write Reduction and Transcript Search

This document records Rin's implemented worker-recovery write reductions and transcript-search schema.

## Invariants

- Transcript archives remain the source of truth. The transcript search database is a rebuildable index.
- Persisted state is written only when its semantic value changes.

## Upgrade support window

Migration retention follows the first-parent `main` commit timeline rather than release channels or schema publication dates. The current cutoff is `cf36cf45e512f08c47aa4ffe656927c52f0d8d1f` (`2026-07-20T14:04:41+08:00`), the oldest commit inside the accepted 30-day window when this boundary was set. Its persisted shapes are Chat schema 5 and transcript-search schema 5; those are the oldest fixtures that the current migration path promises to upgrade. Older shapes fail closed. The cutoff selects which migrations stay in source; runtime does not calculate dates or query Git history.

## Implemented write reductions

### Running worker recovery state

`running-workers.json` is startup recovery state, not a heartbeat log. Repeated writes of identical state are skipped. An RPC turn heartbeat also consolidates worker-state synchronization so one lifecycle event reaches the persistence boundary once.

Expected steady-state behavior:

- turn start or a real ownership/state transition writes the recovery record;
- identical heartbeats do not replace the file;
- terminal state removes the running record;
- daemon startup reads the same durable shape as before.

## Transcript search schema v5

### Measured current shape

One local index contained 426,392 entries in an 11.54 GB database. Read-only `dbstat` and column-length measurements attributed the largest surfaces as follows:

| Surface                         | Size or logical payload |
| ------------------------------- | ----------------------: |
| `entries` table                 |                 5.87 GB |
| `entry_json` inside `entries`   | 4.19 GB logical payload |
| indexed `text` inside `entries` | 0.95 GB logical payload |
| token FTS content table         |                 1.17 GB |
| trigram FTS content table       |                 1.17 GB |
| token FTS index data            |                 0.38 GB |
| trigram FTS index data          |                 2.74 GB |

Schema v4 needed `entry_json` because search-result presentation and full-session loading reconstructed canonical entries from the index. Its two ordinary FTS5 tables also retained their own content copies.

### Implemented target

Schema v5:

1. removes `entry_json` from the rebuildable index;
2. reconstructs compact search results from indexed columns;
3. loads full session entries from the canonical transcript archive and reports a missing canonical archive explicitly;
4. uses external-content FTS5 tables backed by `entries` and trigger-owned index synchronization;
5. keeps the token and trigram indexes;
6. batches incremental index updates behind one process-local writer transaction, committing at 32 entries, after 10 milliseconds, or before a query/repair;
7. creates one process-owned dirty marker before that process's first canonical archive append, records both PID and process-start identity, flushes and removes it on graceful exit, marks it failed after an archive/index error so other processes can repair immediately, and repairs canonical archives when a process finds a failed or stale marker from a killed or PID-reused writer;
8. avoids rewriting unchanged schema metadata on ordinary opens;
9. marks a newly created or reset search database `rebuild_required`, so an absent index is reconstructed from existing canonical archives before the first query;
10. keeps persisted-shape ownership in the installer: an atomic schema-authority sidecar lets ordinary runtime reject unmarked legacy databases without opening or changing their main/WAL/SHM files; install/update preflight uses the staged runtime to build and verify a separate schema-v6 candidate while the live v5 index remains available, then the installer acquires a target-user runtime update fence before stopping the old daemon, verifies the stopped process by acquiring the target user's daemon-instance migration lease, and keeps both leases through migration and activation. Daemon startup rejects a live fence, and the Linux user unit carries the same path condition, so an older installed daemon cannot race a first fence-aware update through systemd. The fence holder is tied to the updater pipe; a SQLite kernel file lock is the ownership authority, while diagnostics record PID and process-start identity where the platform exposes it. After readiness, the updater continuously supervises each target-user holder and fail-stops immediately if one exits outside the release path, because continuing an in-flight migration without its kernel lease would be unsafe. First-upgrade compatibility pre-populates owner metadata in a sibling marker and atomically publishes `daemon.lock` as a POSIX symlink or Windows directory junction, while an ownerless marker from the old mkdir-then-write protocol is treated as pending and fails closed instead of being reclaimed. Release first detaches its exact published marker to a private path, so a retry cannot delete a legacy daemon that subsequently wins the canonical path. The Linux runtime fence is cleared with the user runtime directory on reboot and is stale-recoverable by daemon startup, the next update, or an explicit lifecycle command without changing the administrator's enabled or masked unit state. The target-user migration records the original live-file set in a durable phase manifest, moves only those files into a recoverable backup, places a directory guard at `search.db`, catches up canonical archive changes, and renames the closed candidate into the guarded path. Large canonical JSONL files are streamed into bounded SQLite batches so preflight never constructs a whole-archive JavaScript string. A compatible completed or interrupted staging database is reused and caught up on retry instead of rebuilding the full corpus. The backup remains authoritative until candidate activation succeeds; activation failure restores the legacy files before the fence is released and the compatible runtime is restarted, while activation success publishes the `current` marker before best-effort backup cleanup. An upgrade with supported search data fails closed if the staged runtime is unavailable, and only a verified completed rebuild publishes the `current` marker.

The logical `entry_json` payload plus the physical sizes of both FTS content tables are nominally 6.53 GB, or 56.5% of the measured database size. Those measurements are not additive physical page savings: `entry_json` is a logical column-length total, while the FTS values come from `dbstat`. Only a rebuilt candidate database can establish actual reclaimed pages. The design does not remove the token or trigram indexes themselves.

### Measured result

A 3,000-entry synthetic corpus covered English tokens, structured path-like terms, Chinese text, substring search, tool metadata, and oversized canonical JSON payloads. The candidate used external-content token/trigram FTS and omitted `entry_json` from the index.

| Metric                         |    Current shape |       Candidate |
| ------------------------------ | ---------------: | --------------: |
| Database size after checkpoint | 28,053,504 bytes | 8,261,632 bytes |
| Batched insertion time         |        132.52 ms |        87.11 ms |

The candidate was 70.6% smaller and inserted 34.3% faster in this synthetic run. Four token/trigram query classes returned identical ordered top-50 row keys. Repeated query latency was effectively unchanged in that run.

The implementation uses this shape. A separate 1,000-entry end-to-end run through Rin's actual archive/index API produced a 1,261,568-byte schema-v5 index, no `entry_json` column or FTS content shadow tables, a 6.51 ms 20-session search, and full canonical session recovery from archive files. End-to-end archive plus index ingestion took 206.15 ms on a RAM-backed test root; this is not a physical-disk endurance estimate.

The memory-search tests cover Chinese and Latin text, structured identifiers, tool names, exact filtering, ranking, full-session archive loading, missing archives, installer-owned schema-v5-to-v6 rebuild, isolated candidate preparation, byte-for-byte preservation of the live legacy main/WAL/SHM set during runtime rejection and preparation, catch-up of archive entries appended after preparation, rejection of a database open while the publish guard is held, restoration of the byte-identical live index after a guarded publish failure, rewritten archives, durable dirty-writer recovery, and interrupted/corrupt repair paths. Production rollout still requires the normal install/update transaction and must not migrate the live index from daemon startup or an ordinary query.

## Non-solutions

- `VACUUM` rewrites a database and does not remove the producer of repeated writes.
- More frequent WAL checkpoints increase checkpoint activity and do not reduce event count.
- `journal_size_limit` bounds retained WAL size, not total bytes written.
