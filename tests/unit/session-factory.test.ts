import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
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
