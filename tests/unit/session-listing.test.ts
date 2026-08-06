import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const listing = await importBuiltModule<
  typeof import("../../src/core/session/listing.js")
>("dist/core/session/listing.js");

test("session listing helpers reject empty inputs", () => {
  assert.equal(listing.normalizeBoundSessionListItem(null), null);
  assert.deepEqual(listing.normalizeBoundSessionList(null), []);
  assert.equal(listing.describeBoundSession(null), null);
  assert.deepEqual(listing.describeBoundSessions(null), []);
  assert.equal(listing.getBoundSessionSubtitle(null), undefined);
  assert.equal(listing.isActiveBoundSession(null, "/tmp/session.jsonl"), false);
});

test("session display helpers keep name fallback rules consistent", () => {
  assert.equal(
    listing.getBoundSessionDisplayTitle({
      name: " Renamed title ",
      firstMessage: " First question ",
      path: "/tmp/demo.jsonl",
      modified: new Date("2026-04-19T00:00:00.000Z"),
    }),
    "Renamed title",
  );
  assert.equal(
    listing.getBoundSessionDisplayTitle({
      firstMessage: " First question ",
      path: "/tmp/demo.jsonl",
      modified: new Date("2026-04-19T00:00:00.000Z"),
    }),
    "First question",
  );
  assert.equal(
    listing.getBoundSessionDisplayTitle({
      path: "/tmp/demo.jsonl",
      modified: new Date("2026-04-19T00:00:00.000Z"),
    }),
    "/tmp/demo.jsonl",
  );
  assert.equal(
    listing.getBoundSessionDisplayTitle({ id: " legacy-session " }),
    "legacy-session",
  );
  assert.equal(listing.getBoundSessionDisplayTitle({}), "Untitled session");
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
