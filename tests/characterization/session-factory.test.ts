import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const factory = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "session", "factory.js"))
    .href
);
const listing = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "session", "listing.js"))
    .href
);
const catalog = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "session", "catalog.js"))
    .href
);
async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function writeSessionRecord(sessionDir, name, entries) {
  const filePath = path.join(sessionDir, name);
  await fs.writeFile(
    filePath,
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  await fs.utimes(
    filePath,
    new Date("2020-01-01T00:00:00.000Z"),
    new Date("2020-01-01T00:00:00.000Z"),
  );
  return filePath;
}

function sessionEntries({ id, cwd, first, last, name, parentSession }) {
  return [
    {
      type: "session",
      version: 3,
      id,
      timestamp: "2026-04-01T00:00:00.000Z",
      cwd,
      ...(parentSession ? { parentSession } : {}),
    },
    {
      type: "message",
      id: `${id}-user`,
      timestamp: first,
      message: {
        role: "user",
        content: [{ type: "text", text: `${id} first message` }],
      },
    },
    ...(name
      ? [
          {
            type: "session_info",
            id: `${id}-name`,
            timestamp: last,
            name,
          },
        ]
      : []),
    {
      type: "message",
      id: `${id}-assistant`,
      timestamp: last,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${id} assistant reply` }],
      },
    },
  ];
}

test("listBoundSessions does not create cwd-encoded empty session dirs", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-agent-"));
  const cwd = path.join(os.tmpdir(), "rin-project-cwd");
  const previousRinDir = process.env.RIN_DIR;
  process.env.RIN_DIR = agentDir;

  try {
    await factory.listBoundSessions({ cwd });
    assert.equal(
      await pathExists(
        path.join(agentDir, "sessions", "--tmp-rin-project-cwd--"),
      ),
      false,
    );
  } finally {
    if (previousRinDir === undefined) {
      delete process.env.RIN_DIR;
    } else {
      process.env.RIN_DIR = previousRinDir;
    }
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("listBoundSessions reads only canonical root sessions", async () => {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-sessions-"));
  await fs.mkdir(path.join(sessionDir, "legacy"));
  const listed = [];
  const sessions = await factory.listBoundSessions({
    cwd: "/tmp/project",
    sessionDir,
    SessionManager: {
      async list(_cwd, dir) {
        listed.push(dir);
        if (dir !== sessionDir) return [];
        return [
          {
            id: "older",
            path: path.join(dir, "older.jsonl"),
            modified: new Date("2026-04-16T00:00:00.000Z"),
          },
          {
            id: "newer",
            path: path.join(dir, "newer.jsonl"),
            modified: new Date("2026-04-17T00:00:00.000Z"),
          },
          {
            id: "duplicate-newer",
            path: path.join(dir, "newer.jsonl"),
            modified: new Date("2026-04-18T00:00:00.000Z"),
          },
        ];
      },
    },
  });

  assert.deepEqual(
    sessions.map((item) => item.id),
    ["newer", "older"],
  );
  assert.deepEqual(listed, [sessionDir]);
  await fs.rm(sessionDir, { recursive: true, force: true });
});

test("listBoundSessionPage returns a bounded recent page from root session records", async () => {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-page-"));
  const cwd = "/tmp/rin-page-project";
  const parentPath = path.join(sessionDir, "parent.jsonl");

  try {
    await writeSessionRecord(
      sessionDir,
      "old.jsonl",
      sessionEntries({
        id: "old",
        cwd,
        first: "2026-04-02T00:00:00.000Z",
        last: "2026-04-02T00:05:00.000Z",
      }),
    );
    await writeSessionRecord(
      sessionDir,
      "new.jsonl",
      sessionEntries({
        id: "new",
        cwd,
        first: "2026-04-04T00:00:00.000Z",
        last: "2026-04-04T00:05:00.000Z",
        name: "Newest named session",
      }),
    );
    await writeSessionRecord(
      sessionDir,
      "middle.jsonl",
      sessionEntries({
        id: "middle",
        cwd,
        first: "2026-04-03T00:00:00.000Z",
        last: "2026-04-03T00:05:00.000Z",
        parentSession: parentPath,
      }),
    );
    await writeSessionRecord(
      sessionDir,
      "other-cwd.jsonl",
      sessionEntries({
        id: "other-cwd",
        cwd: "/tmp/other-project",
        first: "2026-04-05T00:00:00.000Z",
        last: "2026-04-05T00:05:00.000Z",
      }),
    );

    const firstPage = await factory.listBoundSessionPage({
      cwd,
      sessionDir,
      limit: 2,
    });
    assert.deepEqual(
      firstPage.sessions.map((session) => session.id),
      ["new", "middle"],
    );
    assert.equal(firstPage.total, 3);
    assert.equal(firstPage.hasMore, true);
    assert.equal(firstPage.nextOffset, 2);
    assert.equal(firstPage.sessions[0].name, "Newest named session");
    assert.equal(firstPage.sessions[0].messageCount, 2);
    assert.equal(firstPage.sessions[1].parentSessionPath, parentPath);
    assert.equal(firstPage.sessions[0].cwd, undefined);

    const secondPage = await factory.listBoundSessionPage({
      cwd,
      sessionDir,
      limit: 2,
      offset: firstPage.nextOffset,
    });
    assert.deepEqual(
      secondPage.sessions.map((session) => session.id),
      ["old"],
    );
    assert.equal(secondPage.hasMore, false);
  } finally {
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
});

test("listBoundSessionPage uses a built catalog without reparsing session jsonl files", async () => {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-catalog-"));
  const cwd = "/tmp/rin-catalog-project";

  try {
    await writeSessionRecord(
      sessionDir,
      "old.jsonl",
      sessionEntries({
        id: "old",
        cwd,
        first: "2026-04-02T00:00:00.000Z",
        last: "2026-04-02T00:05:00.000Z",
      }),
    );
    await writeSessionRecord(
      sessionDir,
      "new.jsonl",
      sessionEntries({
        id: "new",
        cwd,
        first: "2026-04-03T00:00:00.000Z",
        last: "2026-04-03T00:05:00.000Z",
      }),
    );

    await catalog.rebuildSessionCatalog(sessionDir);
    await fs.writeFile(path.join(sessionDir, "old.jsonl"), "not jsonl\n");
    await fs.writeFile(path.join(sessionDir, "new.jsonl"), "not jsonl\n");

    const page = await factory.listBoundSessionPage({
      cwd,
      sessionDir,
      limit: 1,
    });

    assert.deepEqual(
      page.sessions.map((session) => session.id),
      ["new"],
    );
    assert.equal(page.hasMore, true);
    assert.equal(page.nextOffset, 1);
  } finally {
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
});

test("session catalog updates from a session manager without deleting sessions", async () => {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-catalog-"));
  const cwd = "/tmp/rin-catalog-live-project";
  const sessionFile = path.join(sessionDir, "live.jsonl");

  try {
    await fs.writeFile(sessionFile, "placeholder\n");
    await catalog.updateSessionCatalogFromSessionManagerSync({
      sessionFile,
      fileEntries: sessionEntries({
        id: "live",
        cwd,
        first: "2026-04-03T00:00:00.000Z",
        last: "2026-04-03T00:05:00.000Z",
        name: "Live indexed session",
      }),
      isPersisted: () => true,
    });

    const page = await catalog.tryListSessionCatalogPage({
      cwd,
      sessionDir,
      offset: 0,
      limit: 1,
    });
    assert.equal(page?.sessions[0]?.id, "live");
    assert.equal(page.sessions[0]?.name, "Live indexed session");
    assert.equal(await pathExists(sessionFile), true);
  } finally {
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
});

test("listBoundSessions uses the fast page path when pagination is requested", async () => {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-page-"));
  const cwd = "/tmp/rin-page-project";
  let exactListCalled = false;

  try {
    await writeSessionRecord(
      sessionDir,
      "session.jsonl",
      sessionEntries({
        id: "session",
        cwd,
        first: "2026-04-02T00:00:00.000Z",
        last: "2026-04-02T00:05:00.000Z",
      }),
    );
    const sessions = await factory.listBoundSessions({
      cwd,
      sessionDir,
      limit: 1,
      SessionManager: {
        async list() {
          exactListCalled = true;
          return [];
        },
      },
    });

    assert.equal(exactListCalled, false);
    assert.deepEqual(
      sessions.map((session) => session.id),
      ["session"],
    );
  } finally {
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
});

test("listBoundSessions normalizes legacy session metadata into canonical fields", async () => {
  const sessions = await factory.listBoundSessions({
    cwd: "/tmp/project",
    sessionDir: "/tmp/sessions",
    SessionManager: {
      async list() {
        return [
          {
            id: "session-1",
            title: "Legacy title",
            subtitle: "2026-04-18T00:00:00.000Z",
          },
        ];
      },
    },
  });

  assert.deepEqual(
    {
      id: sessions[0]?.id,
      path: sessions[0]?.path,
      name: sessions[0]?.name,
      firstMessage: sessions[0]?.firstMessage,
      modified: sessions[0]?.modified?.toISOString(),
      messageCount: sessions[0]?.messageCount,
      cwd: sessions[0]?.cwd,
      allMessagesText: sessions[0]?.allMessagesText,
    },
    {
      id: "session-1",
      path: "session-1",
      name: undefined,
      firstMessage: "Legacy title",
      modified: "2026-04-18T00:00:00.000Z",
      messageCount: 0,
      cwd: undefined,
      allMessagesText: "Legacy title",
    },
  );
});

test("openBoundSession reports an explicit missing session file", async () => {
  await assert.rejects(
    () =>
      factory.openBoundSession({
        cwd: "/tmp/project",
        agentDir: "/tmp/rin-agent",
        sessionFile: "/tmp/missing-rin-session.jsonl",
      }),
    /Session record is missing or expired/,
  );
});

test("renameBoundSession delegates to SessionManager.open once", async () => {
  const renamed = [];
  await factory.renameBoundSession(
    { sessionPath: " /tmp/demo.jsonl " },
    "Renamed",
    {
      SessionManager: {
        open(sessionPath) {
          renamed.push(["open", sessionPath]);
          return {
            appendSessionInfo(name) {
              renamed.push(["rename", name]);
            },
          };
        },
      },
    },
  );

  assert.deepEqual(renamed, [
    ["open", "/tmp/demo.jsonl"],
    ["rename", "Renamed"],
  ]);
});

test("renameBoundSession rejects missing session file selectors", async () => {
  await assert.rejects(
    () =>
      factory.renameBoundSession({ sessionId: "memory-only" }, "Renamed", {
        SessionManager: {
          open() {
            throw new Error("should not reach open");
          },
        },
      }),
    /Session file is required/,
  );
});

test("session listing helpers derive presentation and active state consistently", () => {
  const session = {
    id: "session-1",
    path: "/tmp/session-1.jsonl",
    firstMessage: "Hello",
    modified: new Date("2026-04-18T00:00:00.000Z"),
    messageCount: 0,
    cwd: undefined,
    allMessagesText: "Hello",
  };

  assert.deepEqual(
    listing.describeBoundSession(session, " /tmp/session-1.jsonl "),
    {
      ...session,
      title: "Hello",
      subtitle: "2026-04-18T00:00:00.000Z",
      isActive: true,
    },
  );
  assert.deepEqual(
    listing.describeBoundSessions([session], "/tmp/session-1.jsonl"),
    [
      {
        ...session,
        title: "Hello",
        subtitle: "2026-04-18T00:00:00.000Z",
        isActive: true,
      },
    ],
  );
  assert.equal(
    listing.describeBoundSession({
      id: "legacy-session",
      title: "Legacy title",
      subtitle: "2026-04-19T00:00:00.000Z",
    })?.subtitle,
    "2026-04-19T00:00:00.000Z",
  );
  assert.equal(
    listing.describeBoundSession({
      id: "legacy-session",
      title: "Legacy title",
      modified: "not-a-date",
      subtitle: "2026-04-19T00:00:00.000Z",
    })?.subtitle,
    "2026-04-19T00:00:00.000Z",
  );
  assert.equal(
    listing.describeBoundSession({
      id: "legacy-session",
      title: "Legacy title",
      modified: "not-a-date",
      subtitle: "Legacy subtitle",
    })?.subtitle,
    "Legacy subtitle",
  );
  assert.equal(listing.getBoundSessionDisplayTitle(session), "Hello");
  assert.equal(
    listing.getBoundSessionSubtitle(session),
    "2026-04-18T00:00:00.000Z",
  );
  assert.equal(
    listing.getBoundSessionSubtitle({
      ...session,
      subtitle: "Custom subtitle",
      isActive: false,
      title: "Hello",
    }),
    "2026-04-18T00:00:00.000Z",
  );
  assert.equal(
    listing.isActiveBoundSession(session, " /tmp/session-1.jsonl "),
    true,
  );
});

test("session listing normalization trims legacy values and preserves normalized items", () => {
  const normalized = listing.normalizeBoundSessionListItem({
    id: " session-1 ",
    path: " /tmp/session-1.jsonl ",
    firstMessage: " Hello ",
    modified: "2026-04-18T00:00:00.000Z",
  });

  assert.deepEqual(normalized, {
    id: "session-1",
    path: "/tmp/session-1.jsonl",
    name: undefined,
    firstMessage: "Hello",
    modified: new Date("2026-04-18T00:00:00.000Z"),
    messageCount: 0,
    cwd: undefined,
    allMessagesText: "Hello",
  });
  assert.equal(listing.normalizeBoundSessionListItem(normalized), normalized);
  const legacyNormalized = listing.normalizeBoundSessionListItem({
    id: " legacy-session ",
  });
  assert.deepEqual(
    {
      id: legacyNormalized?.id,
      path: legacyNormalized?.path,
      name: legacyNormalized?.name,
      firstMessage: legacyNormalized?.firstMessage,
      messageCount: legacyNormalized?.messageCount,
      cwd: legacyNormalized?.cwd,
      allMessagesText: legacyNormalized?.allMessagesText,
      modifiedIsDate: legacyNormalized?.modified instanceof Date,
    },
    {
      id: "legacy-session",
      path: "legacy-session",
      name: undefined,
      firstMessage: "legacy-session",
      messageCount: 0,
      cwd: undefined,
      allMessagesText: "legacy-session",
      modifiedIsDate: true,
    },
  );
  assert.deepEqual(
    listing
      .normalizeBoundSessionList([
        normalized,
        {
          id: "session-1-copy",
          path: " /tmp/session-1.jsonl ",
          firstMessage: "Other",
          modified: "2026-04-19T00:00:00.000Z",
        },
      ])
      .map((item) => item.id),
    ["session-1"],
  );
});
