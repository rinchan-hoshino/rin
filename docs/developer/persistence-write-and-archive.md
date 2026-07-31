# Persistence Write Reduction and Archive Design

This document records the implemented write reductions, transcript-search schema, and non-production chat archive prototype for Rin's worker recovery state, usage telemetry, transcript search, and chat history.

## Invariants

- Chat messages and canonical message payloads remain complete and retrievable.
- A storage tier never changes whether content exists. Chat search requires an agent-selected search level; `exhaustive` scans every retained tier, while narrower levels report partial coverage and whether deeper search or another result page is available.
- Operational chat state remains transactionally safe. An archive must not weaken inbox, turn, outbox, reply, or idempotency behavior.
- Transcript archives remain the source of truth. The transcript search database is a rebuildable index.
- During normal database availability, usage telemetry may lose at most one pending batch (up to 32 events or one second) on a hard process kill. Flush failures keep the pending batch bounded for retry and reject new events until the batch can be committed. Normal turn completion and session shutdown attempt a best-effort flush without blocking lifecycle cleanup.
- Persisted state is written only when its semantic value changes.

## Implemented write reductions

### Running worker recovery state

`running-workers.json` is startup recovery state, not a heartbeat log. Repeated writes of identical state are skipped. An RPC turn heartbeat also consolidates worker-state synchronization so one lifecycle event reaches the persistence boundary once.

Expected steady-state behavior:

- turn start or a real ownership/state transition writes the recovery record;
- identical heartbeats do not replace the file;
- terminal state removes the running record;
- daemon startup reads the same durable shape as before.

### Usage telemetry

The token-usage capability queues up to 32 normalized events for at most one second and inserts each batch in one SQLite transaction. It also flushes at `agent_end`, `session_shutdown`, and before a usage query reads the database.

The `telemetry_events_tokens_idx` index is removed. Rin's all-time token aggregate explicitly performs a table scan, bounded aggregates use `telemetry_events_timestamp_idx`, and equality filters use their dimension indexes. The total-token index was not selected by any generated query path.

A 320-event synthetic comparison, using the same schema and event data for both paths, produced:

| Write path               | WAL after inserts |  Elapsed |
| ------------------------ | ----------------: | -------: |
| One autocommit per event |   4,140,632 bytes | 14.07 ms |
| Batches of 32            |     844,632 bytes |  6.57 ms |

This is an approximately 79.6% smaller WAL and 53.3% lower insertion time for that workload. It is a transaction-boundary comparison, not a physical-NAND endurance estimate.

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
10. keeps persisted-shape ownership in the installer: an atomic schema-authority sidecar lets ordinary runtime reject unmarked legacy databases without opening or changing their main/WAL/SHM files; install/update preflight uses the staged runtime to build and verify a separate schema-v5 candidate while the live v4 index remains available, then the installer acquires a target-user runtime update fence before stopping the old daemon, verifies the stopped process by acquiring the target user's daemon-instance migration lease, and keeps both leases through migration and activation. Daemon startup rejects a live fence, and the Linux user unit carries the same path condition, so an older installed daemon cannot race a first fence-aware update through systemd. The fence holder is tied to the updater pipe; a SQLite kernel file lock is the ownership authority, while diagnostics record PID and process-start identity where the platform exposes it. After readiness, the updater continuously supervises each target-user holder and fail-stops immediately if one exits outside the release path, because continuing an in-flight migration without its kernel lease would be unsafe. First-upgrade compatibility pre-populates owner metadata in a sibling marker and atomically publishes `daemon.lock` as a POSIX symlink or Windows directory junction, while an ownerless marker from the old mkdir-then-write protocol is treated as pending and fails closed instead of being reclaimed. Release first detaches its exact published marker to a private path, so a retry cannot delete a legacy daemon that subsequently wins the canonical path. The Linux runtime fence is cleared with the user runtime directory on reboot and is stale-recoverable by daemon startup, the next update, or an explicit lifecycle command without changing the administrator's enabled or masked unit state. The target-user migration records the original live-file set in a durable phase manifest, moves only those files into a recoverable backup, places a directory guard at `search.db`, catches up canonical archive changes, and renames the closed candidate into the guarded path. Large canonical JSONL files are streamed into bounded SQLite batches so preflight never constructs a whole-archive JavaScript string. A compatible completed or interrupted staging database is reused and caught up on retry instead of rebuilding the full corpus. The backup remains authoritative until candidate activation succeeds; activation failure restores the legacy files before the fence is released and the compatible runtime is restarted, while activation success publishes the `current` marker before best-effort backup cleanup. An upgrade with legacy search data fails closed if the staged runtime is unavailable, and only a verified completed rebuild publishes the `current` marker.

The logical `entry_json` payload plus the physical sizes of both FTS content tables are nominally 6.53 GB, or 56.5% of the measured database size. Those measurements are not additive physical page savings: `entry_json` is a logical column-length total, while the FTS values come from `dbstat`. Only a rebuilt candidate database can establish actual reclaimed pages. The design does not remove the token or trigram indexes themselves.

### Prototype result

A 3,000-entry synthetic corpus covered English tokens, structured path-like terms, Chinese text, substring search, tool metadata, and oversized canonical JSON payloads. The candidate used external-content token/trigram FTS and omitted `entry_json` from the index.

| Metric                         |    Current shape |       Candidate |
| ------------------------------ | ---------------: | --------------: |
| Database size after checkpoint | 28,053,504 bytes | 8,261,632 bytes |
| Batched insertion time         |        132.52 ms |        87.11 ms |

The candidate was 70.6% smaller and inserted 34.3% faster in this synthetic run. Four token/trigram query classes returned identical ordered top-50 row keys. Repeated query latency was effectively unchanged in that run.

The source implementation retains this prototype's shape. A separate 1,000-entry end-to-end run through Rin's actual archive/index API produced a 1,261,568-byte schema-v5 index, no `entry_json` column or FTS content shadow tables, a 6.51 ms 20-session search, and full canonical session recovery from archive files. A same-corpus schema-v4 fixture was 4,866,048 bytes, so the measured index-size reduction was 74.1%. End-to-end archive plus index ingestion took 206.15 ms on a RAM-backed test root; this is not a physical-disk endurance estimate.

The memory-search tests cover Chinese and Latin text, structured identifiers, tool names, exact filtering, ranking, full-session archive loading, missing archives, installer-owned schema-v4 rebuild, isolated candidate preparation, byte-for-byte preservation of the live legacy main/WAL/SHM set during runtime rejection and preparation, catch-up of archive entries appended after preparation, rejection of a database open while the publish guard is held, restoration of the byte-identical live index after a guarded publish failure, rewritten archives, durable dirty-writer recovery, and interrupted/corrupt repair paths. Production rollout still requires the normal install/update transaction and must not migrate the live index from daemon startup or an ordinary query.

## Chat history tiers and cold archive

### Why payload tiering is safer than moving message identity

`turns.inbound_message_id` references `messages.id`, and chat recovery, ordering, replies, and idempotency depend on message identity and metadata. Moving complete message rows would either break those relationships or require archiving the whole operational graph.

Keep a small message header in the hot database and tier the large payload separately:

- **L0 operational header** — always hot. Identity, chat/order keys, timestamps, disposition, reply/thread links, recovery fields, payload hash, and payload locator.
- **L1 hot payload** — recent or operationally active canonical payloads. All messages referenced by pending/running work remain here.
- **L2 conversation archive** — terminal actionable conversations, commands, assistant replies, and superseded turns after a configurable hot window.
- **L3 ambient archive** — `record_only` group traffic and other non-actionable history after a shorter hot window.
- **Pinned** is an independent flag, not a deletion exception. Pinned content remains full and searchable and may be kept hot for latency.

All levels preserve the canonical `record_json`, text fields, elements, quotes, and textual attachment metadata. The prototype requires the agent to choose a search level:

- `quick` searches L1 hot payloads;
- `standard` searches L1 hot plus L2 conversation segments;
- `exhaustive` searches L1, L2, and L3 ambient/`record_only` segments.

Every response reports `searchedTiers`, `segmentsScanned`, coverage, whether deeper search is available, candidate count, whether that count is only a lower bound, and whether another page is available. `limit` and `offset` provide deterministic pagination through the supported 10,000-row offset window. Coverage describes the tiers scanned, not whether a result page contains every hit.

### Archive format

Use immutable versioned calendar shards. A month is a partition key, not a single mutable file:

```text
~/.rin/data/chat/archive/YYYY/MM/messages-0001.sqlite
~/.rin/data/chat/archive/YYYY/MM/messages-0002.sqlite
```

A finalized segment is never reopened for writes. Messages that become eligible later enter the next segment for that month. The manifest orders every segment and lets queries merge all segments intersecting the requested date range.

Each shard contains:

- canonical message payloads keyed by message ID and payload hash;
- an external-content FTS5 index over searchable text;
- shard schema version and min/max timestamps;
- row count and content checksum.

A small manifest in the hot database records shard path, state, schema version, row count, time range, checksum, reservation owner, and staging/committed/rolled-back state. The prototype query service searches the tiers selected by the agent, merges results with deterministic `received_at DESC, message_id ASC` ordering, paginates them, then resolves full payloads from their locators. Catalog reads use one SQLite snapshot so a concurrent archive or rollback switch cannot make a payload disappear between locator reads. The prototype lives in `src/core/chat/archive-prototype.ts`; no daemon, bridge, or install path imports or activates it.

### Archive transaction

Archive work belongs to an install/update migration or an explicit maintenance command, never daemon startup.

1. Read-only preflight selects eligible payloads. Pending/running turns and unresolved delivery/recovery references are excluded.
2. Reserve the period sequence and final path under `BEGIN IMMEDIATE`, recording an owner nonce and PID in a staging manifest row. Failed or abandoned reservations become permanent tombstones so a final path is never reused.
3. Write a staging shard with full payloads and FTS rows.
4. Verify row counts, per-payload hashes, sample retrieval, FTS coverage, and shard integrity.
5. Publish with a same-filesystem hard link, which fails instead of replacing an existing final path, then unlink the staging name.
6. In one hot-database transaction, compare-and-swap the owned reservation to committed, update payload locators/tiers, and remove only the duplicated hot payload bodies.
7. Reconcile old staging rows owned by dead processes by compare-and-swapping them to `abandoned`, then remove only files tied to that exact reservation. The sequence tombstone remains, preventing cleanup from racing with a later publisher. A hot row is never removed before a verified final shard exists.

Rollback restores payloads by locator and hash. Archive failure leaves the current hot payload untouched and retryable. Final immutable files remain available after rollback so readers holding an older catalog snapshot can still resolve them.

### Decisions required before production integration

- hot windows for L2 conversation and L3 ambient payloads;
- which textual fields count as full-text searchable content;
- whether pinned payloads must remain hot or only receive a search-ranking boost;
- acceptable all-time search latency and maximum number of shards;
- whether old immutable shards may move to NAS while retaining a local searchable index and explicit offline state.

## Non-solutions

- `VACUUM` rewrites a database and does not remove the producer of repeated writes.
- More frequent WAL checkpoints increase checkpoint activity and do not reduce event count.
- `journal_size_limit` bounds retained WAL size, not total bytes written.
- Deleting old user messages is not an archive strategy.
