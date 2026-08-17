import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

await import("../support/register-paged-listing-owner-fixture.ts");
const paged = await import("../../dist/core/session/paged-listing.js");

test("session paging falls back to sorted record summaries when catalog preparation fails", async () => {
  const cwd = path.resolve("/owner/project");
  (globalThis as any).__rinPagedListingEnsureError = new Error(
    "owner catalog unavailable",
  );
  (globalThis as any).__rinPagedListingFiles = ["old", "new", "other", "none"];
  (globalThis as any).__rinPagedListingSummaries = [
    { id: "old", cwd, modified: new Date("2026-07-14T00:00:00.000Z") },
    { id: "new", cwd, modified: new Date("2026-07-16T00:00:00.000Z") },
    {
      id: "other",
      cwd: path.resolve("/owner/other"),
      modified: new Date("2026-07-17T00:00:00.000Z"),
    },
    { id: "none", modified: new Date("2026-07-18T00:00:00.000Z") },
  ];

  const first = await paged.listBoundSessionPage({
    sessionDir: "/owner/sessions",
    cwd: "/owner/project/../project",
    limit: 1,
  });
  assert.deepEqual(
    first.sessions.map((session) => session.id),
    ["new"],
  );
  assert.deepEqual(first, {
    sessions: [first.sessions[0]],
    offset: 0,
    limit: 1,
    total: 2,
    hasMore: true,
    nextOffset: 1,
  });

  const second = await paged.listBoundSessionPage({
    sessionDir: "/owner/sessions",
    cwd,
    offset: first.nextOffset,
    limit: 10,
  });
  assert.deepEqual(
    second.sessions.map((session) => session.id),
    ["old"],
  );
  assert.equal(second.hasMore, false);
  assert.equal(second.nextOffset, undefined);

  const all = await paged.listBoundSessionPage({
    sessionDir: "/owner/sessions",
    limit: 10,
  });
  assert.deepEqual(
    all.sessions.map((session) => session.id),
    ["none", "other", "new", "old"],
  );
});
