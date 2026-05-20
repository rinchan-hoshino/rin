import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const transcripts = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "memory", "transcripts.js"))
    .href
);
const transcriptArchiveModule = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "memory", "transcript-archive.js"),
  ).href
);
const memoryExtensionModule = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "memory", "index.js")).href
);
const BetterSqlite3 = (await import("better-sqlite3")).default;

async function withTempRoot(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-memory-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeSessionFile(root, name, entries) {
  const filePath = path.join(root, "sessions", name);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
  return filePath;
}

async function withJsonlDaemonSocket(handler, fn) {
  const runtimeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-memory-daemon-"),
  );
  const socketPath = path.join(runtimeDir, "rin-daemon", "daemon.sock");
  const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const payload = JSON.parse(line);
        Promise.resolve(handler(payload)).then((data) => {
          socket.write(
            `${JSON.stringify({
              type: "response",
              id: payload.id,
              command: payload.type,
              success: true,
              data,
            })}\n`,
          );
        });
      }
    });
  });
  await fs.mkdir(path.dirname(socketPath), { recursive: true });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  try {
    await fn(socketPath);
  } finally {
    if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
    await new Promise((resolve) => server.close(() => resolve()));
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
}

test("memory transcripts archive entries under memory/transcripts", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-04T11:11:11.000Z",
        sessionId: "session-1",
        sessionFile: "/tmp/session-1.jsonl",
        role: "user",
        content: [
          { type: "text", text: "Does Rin keep raw conversation transcripts?" },
        ],
      },
      root,
    );

    const sessionPath = transcripts.getTranscriptArchivePath(
      {
        timestamp: "2026-04-04T11:11:11.000Z",
        sessionId: "session-1",
      },
      root,
    );
    assert.match(
      sessionPath,
      /memory[\\/]transcripts[\\/]2026[\\/]04[\\/]session-1\.jsonl$/,
    );
  });
});

test("memory search returns session-level archived transcript matches and creates persistent index", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-04T11:11:11.000Z",
        sessionId: "session-1",
        sessionFile: "/tmp/session-1.jsonl",
        role: "user",
        content: [
          { type: "text", text: "Does Rin keep raw conversation transcripts?" },
        ],
      },
      root,
    );

    const results = await transcripts.searchTranscriptArchive(
      "raw conversation transcripts",
      { limit: 8 },
      root,
    );
    assert.ok(Array.isArray(results));
    assert.equal(results[0].sourceType, "session");
    assert.equal(results[0].sessionId, "session-1");
    assert.match(results[0].path, /2026[\\/]04[\\/]session-1\.jsonl$/);
    assert.match(results[0].preview, /raw conversation transcripts/);
    assert.equal(results[0].hitCount, 1);

    const searchDbPath = path.join(root, "memory", "search.db");
    await assert.doesNotReject(() => fs.access(searchDbPath));
  });
});

test("memory search does not match session file paths", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-04T11:11:11.000Z",
        sessionId: "chat-session-opaque-id",
        sessionFile:
          "/home/rin/.rin/sessions/2026-05-13T06-14-31-561Z_019e1ff8-fb89-710d-931e-a3e01347c315.jsonl",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Discussed the public mirror sync repair and validation plan.",
          },
        ],
      },
      root,
    );

    const byContent = await transcripts.searchTranscriptArchive(
      "public mirror sync repair",
      { limit: 8 },
      root,
    );
    assert.equal(byContent.length, 1);
    assert.equal(byContent[0].sessionId, "chat-session-opaque-id");

    const bySessionFile = await transcripts.searchTranscriptArchive(
      "019e1ff8-fb89-710d-931e-a3e01347c315",
      { limit: 8 },
      root,
    );
    assert.deepEqual(bySessionFile, []);
  });
});

test("memory search index stays in sync when an archived session file grows", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-04T11:11:11.000Z",
        sessionId: "session-sync",
        sessionFile: "/tmp/session-sync.jsonl",
        role: "assistant",
        content: [{ type: "text", text: "first alpha result" }],
      },
      root,
    );

    const first = await transcripts.searchTranscriptArchive(
      "alpha",
      { limit: 8 },
      root,
    );
    assert.equal(first.length, 1);
    assert.equal(first[0].hitCount, 1);

    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-04T11:11:12.000Z",
        sessionId: "session-sync",
        sessionFile: "/tmp/session-sync.jsonl",
        role: "assistant",
        content: [{ type: "text", text: "second beta result" }],
      },
      root,
    );

    const second = await transcripts.searchTranscriptArchive(
      "beta",
      { limit: 8 },
      root,
    );
    assert.equal(second.length, 1);
    assert.equal(second[0].sessionId, "session-sync");
    assert.equal(second[0].hitCount, 1);
  });
});

test("memory search indexes numeric millisecond timestamps for recent ordering", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-04T11:11:11.000Z",
        sessionId: "session-older-iso",
        sessionFile: "/tmp/session-older-iso.jsonl",
        role: "assistant",
        content: [{ type: "text", text: "older iso timestamp entry" }],
      },
      root,
    );

    const newerTimestamp = String(Date.UTC(2026, 4, 11, 7, 0, 0));
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: newerTimestamp,
        sessionId: "session-newer-ms",
        sessionFile: "/tmp/session-newer-ms.jsonl",
        role: "assistant",
        content: [{ type: "text", text: "newer numeric timestamp entry" }],
      },
      root,
    );

    const recent = await transcripts.loadRecentTranscriptSessions(
      { limit: 2 },
      root,
    );
    assert.equal(recent[0].sessionId, "session-newer-ms");
    assert.equal(recent[1].sessionId, "session-older-iso");
  });
});

test("memory transcripts preserve assistant tool calls and thinking for recall", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-04T11:11:11.000Z",
        sessionId: "session-2",
        sessionFile: "/tmp/session-2.jsonl",
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Need to inspect the repo before editing.",
          },
          {
            type: "toolCall",
            id: "call-1",
            name: "read",
            args: { path: "/tmp/demo.txt" },
          },
          { type: "text", text: "I checked the file and found the setting." },
        ],
      },
      root,
    );

    const byTool = await transcripts.searchTranscriptArchive(
      "read /tmp/demo.txt",
      { limit: 8 },
      root,
    );
    assert.equal(byTool[0].sessionId, "session-2");
    assert.match(byTool[0].preview, /tool:read/);
    assert.match(byTool[0].preview, /demo\.txt/);
    assert.ok(Array.isArray(byTool[0].messages));
    assert.match(byTool[0].messages[0].text, /demo\.txt/);
    assert.equal(byTool[0].messages[0].line, 1);

    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-04T11:12:11.000Z",
        sessionId: "session-2",
        sessionFile: "/tmp/session-2.jsonl",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Updated the same session with a follow-up note about retries.",
          },
        ],
      },
      root,
    );
    const followUp = await transcripts.searchTranscriptArchive(
      "follow-up note retries",
      { limit: 8 },
      root,
    );
    assert.equal(followUp[0].sessionId, "session-2");

    const entries = await transcripts.loadTranscriptSessionEntries(
      { sessionId: "session-2" },
      root,
    );
    assert.equal(entries.length, 2);
    assert.match(entries[0].text, /Need to inspect the repo/);
    assert.match(entries[0].text, /tool:read/);
    assert.match(entries[1].text, /follow-up note about retries/);
  });
});

test("memory can browse recent sessions without a query", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-04T11:11:11.000Z",
        sessionId: "session-1",
        sessionFile: "/tmp/session-1.jsonl",
        role: "assistant",
        content: [{ type: "text", text: "This is an older session." }],
      },
      root,
    );
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-05T12:22:22.000Z",
        sessionId: "session-2",
        sessionFile: "/tmp/session-2.jsonl",
        role: "user",
        content: [{ type: "text", text: "This is the latest session." }],
      },
      root,
    );
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-05T12:22:23.000Z",
        sessionId: "session-2",
        sessionFile: "/tmp/session-2.jsonl",
        role: "toolResult",
        toolName: "read",
        content: "tool output should not replace the session preview",
      },
      root,
    );
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-05T12:22:24.000Z",
        sessionId: "session-2",
        sessionFile: "/tmp/session-2.jsonl",
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "browser_click",
            args: { selector: "Next" },
          },
          {
            type: "text",
            text: "Stuck on the captcha page; next step is to receive the captcha.",
          },
        ],
      },
      root,
    );

    const results = await transcripts.loadRecentTranscriptSessions(
      { limit: 2 },
      root,
    );
    assert.ok(Array.isArray(results));
    assert.equal(results.length, 2);
    assert.equal(results[0].sourceType, "session");
    assert.equal(results[0].sessionId, "session-2");
    assert.match(results[0].preview, /browser_click/);
    assert.match(results[0].preview, /captcha/);
    assert.doesNotMatch(results[0].preview, /tool output should not replace/);
    assert.ok(Array.isArray(results[0].messages));
    assert.ok(results[0].messages.length >= 1);
    assert.ok(Number.isInteger(results[0].messages[0].line));
    assert.equal(results[1].sessionId, "session-1");
  });
});

test("presentSessionResult shares ranked preview and message ordering while keeping latest timestamp", () => {
  const result = transcriptArchiveModule.presentSessionResult(
    [
      {
        id: "assistant-tool",
        timestamp: "2026-04-05T12:22:24.000Z",
        sessionId: "session-2",
        sessionFile: "/tmp/session-2.jsonl",
        role: "assistant",
        text: '[tool:browser_click] {"selector":"Next"}\nStuck on the captcha page; next step is to receive the captcha.',
        toolName: "browser_click",
      },
      {
        id: "newer-tool-result",
        timestamp: "2026-04-05T12:22:25.000Z",
        sessionId: "session-2",
        sessionFile: "/tmp/session-2.jsonl",
        role: "toolResult",
        text: "tool output should not replace the session preview",
        toolName: "read",
      },
      {
        id: "older-user",
        timestamp: "2026-04-05T12:22:22.000Z",
        sessionId: "session-2",
        sessionFile: "/tmp/session-2.jsonl",
        role: "user",
        text: "This is the latest session.",
      },
    ],
    7,
  );

  assert.match(result.preview, /browser_click/);
  assert.equal(result.messages[0].id, "assistant-tool");
  assert.equal(result.messages[1].id, "newer-tool-result");
  assert.equal(result.timestamp, "2026-04-05T12:22:25.000Z");
});

test("memory search merges multiple message hits from the same session", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-06T10:00:00.000Z",
        sessionId: "session-a",
        sessionFile: "/tmp/session-a.jsonl",
        role: "assistant",
        content: [
          { type: "text", text: "Debugged chat outbound send routing." },
        ],
      },
      root,
    );
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-06T10:01:00.000Z",
        sessionId: "session-a",
        sessionFile: "/tmp/session-a.jsonl",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Fixed chat reply context and outbound send retry.",
          },
        ],
      },
      root,
    );
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-06T11:00:00.000Z",
        sessionId: "session-b",
        sessionFile: "/tmp/session-b.jsonl",
        role: "assistant",
        content: [
          { type: "text", text: "Looked at unrelated Telegram bridge code." },
        ],
      },
      root,
    );

    const results = await transcripts.searchTranscriptArchive(
      "chat outbound send",
      { limit: 2 },
      root,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].sessionId, "session-a");
    assert.equal(results[0].hitCount, 2);
    assert.ok(Array.isArray(results[0].messages));
    assert.equal(results[0].messages.length, 2);
  });
});

test("memory search avoids full entries-table exact scans before FTS lookup", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-06T12:00:00.000Z",
        sessionId: "session-fast-search",
        sessionFile: "/tmp/session-fast-search.jsonl",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Debugged chat outbound send routing without a table scan.",
          },
        ],
      },
      root,
    );

    const originalPrepare = BetterSqlite3.prototype.prepare;
    const likePreScans: string[] = [];
    const fullSessionLoads: string[] = [];
    BetterSqlite3.prototype.prepare = function patchedPrepare(sql, ...args) {
      const text = String(sql || "");
      if (/\bLIKE\b/i.test(text)) likePreScans.push(text);
      if (/WHERE session_key IN/i.test(text)) fullSessionLoads.push(text);
      return originalPrepare.call(this, sql, ...args);
    };

    try {
      const results = await transcripts.searchTranscriptArchive(
        "chat outbound send",
        { limit: 8 },
        root,
      );
      assert.equal(results.length, 1);
      assert.equal(results[0].sessionId, "session-fast-search");
      assert.deepEqual(likePreScans, []);
      assert.deepEqual(fullSessionLoads, []);
    } finally {
      BetterSqlite3.prototype.prepare = originalPrepare;
    }
  });
});

test("memory search handles structured identifiers beyond exact raw substrings", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-07T08:08:08.000Z",
        sessionId: "session-ident",
        sessionFile: "/tmp/session-ident.jsonl",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Investigated chat-send.ts for the P2.2 outbound bridge regression.",
          },
        ],
      },
      root,
    );

    const results = await transcripts.searchTranscriptArchive(
      "chat send p2.2",
      { limit: 8 },
      root,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].sessionId, "session-ident");
    assert.match(results[0].preview, /chat-send\.ts/);
    assert.match(results[0].messages[0].text, /P2\.2/);
  });
});

test("memory search requires explicit repair for transcript files written outside incremental indexing", async () => {
  await withTempRoot(async (root) => {
    const entry = {
      id: "manual-1",
      timestamp: "2026-04-08T09:09:09.000Z",
      sessionId: "session-manual-repair",
      sessionFile: "/tmp/session-manual-repair.jsonl",
      role: "assistant",
      text: "Manual transcript write requires explicit repair.",
    };
    const archivePath = transcripts.getTranscriptArchivePath(entry, root);
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.writeFile(archivePath, `${JSON.stringify(entry)}\n`);

    const beforeRepair = await transcripts.searchTranscriptArchive(
      "explicit repair",
      { limit: 8 },
      root,
    );
    assert.equal(beforeRepair.length, 0);

    const repair = await transcripts.repairTranscriptSearchIndex(root);
    assert.equal(repair.fileCount, 1);
    assert.equal(repair.entryCount, 1);

    const afterRepair = await transcripts.searchTranscriptArchive(
      "explicit repair",
      { limit: 8 },
      root,
    );
    assert.equal(afterRepair.length, 1);
    assert.equal(afterRepair[0].sessionId, entry.sessionId);
  });
});

test("memory search repair refreshes rewritten transcript archives without stale rows", async () => {
  await withTempRoot(async (root) => {
    const firstEntry = {
      id: "manual-rewrite-1",
      timestamp: "2026-04-08T09:09:09.000Z",
      sessionId: "session-manual-rewrite",
      sessionFile: "/tmp/session-manual-rewrite.jsonl",
      role: "assistant",
      text: "alpha rewrite marker",
    };
    const archivePath = transcripts.getTranscriptArchivePath(firstEntry, root);
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.writeFile(archivePath, `${JSON.stringify(firstEntry)}\n`);

    await transcripts.repairTranscriptSearchIndex(root);
    const firstResults = await transcripts.searchTranscriptArchive(
      "alpha rewrite marker",
      { limit: 8, fidelity: "exact" },
      root,
    );
    assert.equal(firstResults.length, 1);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const secondEntry = {
      ...firstEntry,
      id: "manual-rewrite-2",
      text: "beta rewrite marker with longer text",
    };
    await fs.writeFile(archivePath, `${JSON.stringify(secondEntry)}\n`);

    await transcripts.repairTranscriptSearchIndex(root);
    const staleResults = await transcripts.searchTranscriptArchive(
      "alpha rewrite marker",
      { limit: 8, fidelity: "exact" },
      root,
    );
    assert.equal(staleResults.length, 0);

    const refreshedResults = await transcripts.searchTranscriptArchive(
      "beta rewrite marker",
      { limit: 8 },
      root,
    );
    assert.equal(refreshedResults.length, 1);
    assert.equal(refreshedResults[0].sessionId, secondEntry.sessionId);
    assert.equal(refreshedResults[0].hitCount, 1);
  });
});

test("memory transcript session loads can bypass search.db when result path is known", async () => {
  await withTempRoot(async (root) => {
    const entry = {
      timestamp: "2026-04-08T09:09:09.000Z",
      sessionId: "session-direct-path",
      sessionFile: "/tmp/session-direct-path.jsonl",
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Loaded transcript entries directly from the archive path.",
        },
      ],
    };
    await transcripts.appendTranscriptArchiveEntry(entry, root);
    const archivePath = transcripts.getTranscriptArchivePath(entry, root);
    await fs.mkdir(path.join(root, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(root, "memory", "search.db"),
      "not-a-sqlite-db",
    );
    const loaded = await transcripts.loadTranscriptSessionEntries(
      {
        sessionId: entry.sessionId,
        sessionFile: entry.sessionFile,
        path: archivePath,
      },
      root,
    );
    assert.equal(loaded.length, 1);
    assert.match(loaded[0].text, /directly from the archive path/);
  });
});

test("memory transcripts ignore transient in-memory sessions without a session file", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-08T09:09:09.000Z",
        sessionId: "session-transient",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "This should not be archived because the session is ephemeral.",
          },
        ],
      },
      root,
    );
    const results = await transcripts.loadRecentTranscriptSessions(
      { limit: 8 },
      root,
    );
    assert.equal(results.length, 0);
  });
});

test("memory transcripts reject legacy synthetic session summaries", async () => {
  await withTempRoot(async (root) => {
    const sessionFile = await writeSessionFile(root, "legacy-summary.jsonl", [
      {
        type: "session",
        version: 3,
        id: "legacy-summary",
        timestamp: "2026-04-08T09:00:00.000Z",
        cwd: "/tmp/project",
      },
    ]);

    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-08T09:10:00.000Z",
        sessionId: "legacy-summary",
        sessionFile,
        role: "sessionSummary",
        customType: "session_summary",
        text: "zebra only appears in the synthetic summary",
        display: false,
      },
      root,
    );

    const rows = await transcripts.searchTranscriptArchive(
      "zebra",
      { limit: 8 },
      root,
    );
    assert.equal(rows.length, 0);
  });
});

test("search_memory uses the first user message as the session display fallback", async () => {
  await withTempRoot(async (root) => {
    const sessionFile = await writeSessionFile(root, "fallback-session.jsonl", [
      {
        type: "session",
        version: 3,
        id: "fallback-session",
        timestamp: "2026-04-08T09:00:00.000Z",
        cwd: "/tmp/project",
      },
      {
        type: "message",
        id: "msg1",
        parentId: null,
        timestamp: "2026-04-08T09:02:00.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "Need help debugging the outbound chat routing bug",
            },
          ],
        },
      },
    ]);

    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-08T09:09:09.000Z",
        sessionId: "fallback-session",
        sessionFile,
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Verified the affected bridge path and confirmed outbound send recovery.",
          },
        ],
      },
      root,
    );

    const rows = await transcripts.searchTranscriptArchive(
      "outbound send recovery",
      { limit: 8 },
      root,
    );
    assert.equal(rows[0].summary, undefined);
    assert.equal(
      rows[0].name,
      "Need help debugging the outbound chat routing bug",
    );
  });
});

test("search_memory derives the display name without a full readFileSync slurp", async () => {
  await withTempRoot(async (root) => {
    const sessionFile = await writeSessionFile(
      root,
      "single-read-session.jsonl",
      [
        {
          type: "session",
          version: 3,
          id: "single-read-session",
          timestamp: "2026-04-08T09:00:00.000Z",
          cwd: "/tmp/project",
        },
        {
          type: "message",
          id: "msg1",
          parentId: null,
          timestamp: "2026-04-08T09:02:00.000Z",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "Need help debugging the outbound chat routing bug",
              },
            ],
          },
        },
      ],
    );

    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-08T09:09:09.000Z",
        sessionId: "single-read-session",
        sessionFile,
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Verified the affected bridge path and confirmed outbound send recovery.",
          },
        ],
      },
      root,
    );

    const originalReadFileSync = fsSync.readFileSync;
    let sessionFileReadCount = 0;
    fsSync.readFileSync = function patchedReadFileSync(filePath, ...args) {
      if (path.resolve(String(filePath)) === path.resolve(sessionFile)) {
        sessionFileReadCount += 1;
      }
      return originalReadFileSync.call(this, filePath, ...args);
    };

    try {
      const rows = await transcripts.searchTranscriptArchive(
        "outbound send recovery",
        { limit: 8 },
        root,
      );
      assert.equal(
        rows[0].name,
        "Need help debugging the outbound chat routing bug",
      );
      assert.equal(sessionFileReadCount, 0);
    } finally {
      fsSync.readFileSync = originalReadFileSync;
    }
  });
});

test("executeSearchMemory emits an initial status update before finishing", async () => {
  await withTempRoot(async (root) => {
    const updates = [];
    const result = await memoryExtensionModule.executeSearchMemory(
      { query: "no hits yet", limit: 8 },
      { agentDir: root, model: { provider: "test", id: "demo" } },
      "medium",
      undefined,
      (update) => updates.push(update.details.userText),
    );

    assert.deepEqual(updates, [
      'Searching archived sessions for "no hits yet"...',
    ]);
    assert.match(result.details.userText, /No memory results found\./);
  });
});

test("search_memory includes external provider results without local transcript paths", async () => {
  await withTempRoot(async (root) => {
    const requests = [];
    await withJsonlDaemonSocket(
      (payload) => {
        requests.push(payload);
        if (payload.type === "memory_search_external") {
          return {
            results: [
              {
                sourceType: "external",
                provider: "remote-memory",
                id: "remote-hit-1",
                name: "Remote memory hit",
                reference: "mem://remote-hit-1",
                summary:
                  "Remote memory summary from a non-local original-text store.",
                messages: [
                  {
                    line: 1,
                    role: "memory",
                    timestamp: "2026-05-11T06:00:00.000Z",
                    text: "remote snippet only",
                  },
                ],
              },
            ],
          };
        }
        return {};
      },
      async () => {
        const result = await memoryExtensionModule.executeSearchMemory(
          { query: "remote only marker", limit: 8 },
          { agentDir: root, model: { provider: "test", id: "demo" } },
          "medium",
        );

        assert.equal(requests.at(-1)?.type, "memory_search_external");
        assert.equal(requests.at(-1)?.payload?.query, "remote only marker");
        assert.match(result.content[0].text, /mem:\/\/remote-hit-1/);
        assert.match(
          result.details.userText,
          /Remote memory summary from a non-local original-text store/,
        );
        assert.match(result.details.userText, /L1 memory: remote snippet only/);
        assert.doesNotMatch(result.details.userText, /memory\/transcripts/);
      },
    );
  });
});

test("memory message hook publishes transcript archive writes to external memory providers", async () => {
  await withTempRoot(async (root) => {
    const requests = [];
    await withJsonlDaemonSocket(
      (payload) => {
        requests.push(payload);
        return { written: 1 };
      },
      async () => {
        const definition = memoryExtensionModule.default({
          getThinkingLevel: () => "medium",
        });
        await definition.hooks.message_end[0](
          {
            message: {
              id: "msg-remote-1",
              timestamp: "2026-05-11T06:00:00.000Z",
              role: "assistant",
              content: [{ type: "text", text: "send this to remote memory" }],
            },
          },
          {
            agentDir: root,
            sessionId: "session-remote",
            sessionFile: "/tmp/session-remote.jsonl",
          },
        );

        const writeRequest = requests.find(
          (payload) => payload.type === "memory_write_external",
        );
        assert.ok(writeRequest);
        assert.equal(writeRequest.payload.role, "assistant");
        assert.equal(writeRequest.payload.text, "send this to remote memory");
      },
    );
  });
});

test("search_memory user formatting omits duplicate header and shows raw messages", () => {
  const rendered = memoryExtensionModule.formatSearchResult({
    query: "minecraft server",
    results: [
      {
        sessionFile: "/home/rin/.rin/sessions/demo.jsonl",
        path: "/home/rin/.rin/memory/transcripts/2026/04/demo.jsonl",
        summary:
          "Investigated the Minecraft server modpack crash and identified the failing config file.",
        preview: "raw preview should never leak",
        messages: [
          {
            line: 12,
            role: "toolResult",
            toolName: "bash",
            text: "docker restart afbfee08-9ced-462b-9b30-8a5a09c2cb71 && grep 'Done (' logs/latest.log",
          },
        ],
      },
    ],
  });

  assert.doesNotMatch(rendered, /^search_memory minecraft server/m);
  assert.match(
    rendered,
    /\/home\/rin\/\.rin\/memory\/transcripts\/2026\/04\/demo\.jsonl/,
  );
  assert.match(rendered, /Investigated the Minecraft server modpack crash/);
  assert.match(
    rendered,
    /L12 toolResult\/bash: docker restart afbfee08-9ced-462b-9b30-8a5a09c2cb71/,
  );
  assert.doesNotMatch(rendered, /raw preview should never leak/);
});

test("search_memory agent formatting uses archive path and line-numbered raw messages", () => {
  const rendered = memoryExtensionModule.formatAgentSearchResult({
    query: "chat outbound",
    results: [
      {
        timestamp: "2026-04-14T06:05:42.876Z",
        sessionId: "b6745c84-869c-4bc4-9709-9cda7a4f6def",
        sessionFile:
          "/home/rin/.rin/sessions/2026-04-14T06-05-42-876Z_b6745c84-869c-4bc4-9709-9cda7a4f6def.jsonl",
        path: "/home/rin/.rin/memory/transcripts/2026/04/64ccd205-ea35-4716-b2d4-9eff931eb59c.jsonl",
        summary:
          "Fixed the Chat outbound send routing bug and verified the affected bridge path.",
        messages: [
          {
            line: 42,
            role: "assistant",
            text: "Verified the affected bridge path and confirmed outbound send recovery.",
          },
        ],
      },
    ],
  });

  assert.match(rendered, /^search_memory chat outbound \(1\)/m);
  assert.match(
    rendered,
    /1\. \/home\/rin\/\.rin\/memory\/transcripts\/2026\/04\/64ccd205-ea35-4716-b2d4-9eff931eb59c\.jsonl/,
  );
  assert.match(rendered, /L42 assistant: Verified the affected bridge path/);
  assert.doesNotMatch(rendered, /^1\. 2026-04-14T06:05:42\.876Z/m);
});

test("search_memory call formatting keeps query in the TUI tool title", () => {
  const theme = {
    fg: (_name, value) => value,
    bold: (value) => value,
  };
  const rendered = memoryExtensionModule.formatSearchMemoryCall(
    { query: "search_memory hang" },
    theme,
  );
  assert.equal(rendered, "🧠 search_memory hang");
});

test("search_memory rendered result appends timing info", () => {
  const theme = {
    fg: (_name, value) => value,
    bold: (value) => value,
  };
  const rendered = memoryExtensionModule.formatRenderedMemoryResult(
    {
      details: {
        userText: 'Searching archived sessions for "search_memory hang"...',
      },
    },
    { expanded: false, isPartial: false },
    theme,
    false,
    1000,
    3500,
  );

  assert.match(
    rendered,
    /Searching archived sessions for "search_memory hang"/,
  );
  assert.match(rendered, /Took 2\.5s/);
});
