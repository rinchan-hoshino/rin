import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const names = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "session", "names.js")).href
);
const listing = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "session", "listing.js"))
    .href
);

test("readSessionDisplayNameParts combines latest rename with first user message", async () => {
  const sessionDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-session-names-"),
  );
  const sessionFile = path.join(sessionDir, "demo.jsonl");
  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({ type: "session_info", name: "Initial title" }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "  First   question  " },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "Answer" },
      }),
      JSON.stringify({ type: "session_info", name: "Renamed title" }),
      "{not valid json}",
      "",
    ].join("\n"),
    "utf8",
  );

  assert.deepEqual(names.readSessionDisplayNameParts(sessionFile), {
    currentName: "Renamed title",
    firstUserMessage: "First question",
  });

  await fs.rm(sessionDir, { recursive: true, force: true });
});

test("readSessionDisplayNameParts handles chunk-spanning lines without a trailing newline", async () => {
  const sessionDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-session-names-"),
  );
  const sessionFile = path.join(sessionDir, "chunked.jsonl");
  const longUserMessage = "A".repeat(70_000);
  const longRenamedTitle = "B".repeat(70_000);
  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "ignored" },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: longUserMessage },
      }),
      JSON.stringify({ type: "session_info", name: longRenamedTitle }),
    ].join("\n"),
    "utf8",
  );

  assert.deepEqual(names.readSessionDisplayNameParts(sessionFile), {
    currentName: names.normalizeSessionNameDetail(longRenamedTitle),
    firstUserMessage: names.normalizeSessionNameDetail(
      longUserMessage,
      names.DEFAULT_FIRST_USER_MESSAGE_MAX,
    ),
  });

  await fs.rm(sessionDir, { recursive: true, force: true });
});

test("readSessionDisplayNameParts extracts first user text from structured rich content", async () => {
  const sessionDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-session-names-"),
  );
  const sessionFile = path.join(sessionDir, "structured.jsonl");
  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "ignored" },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "thinking", thinking: "hidden plan" },
            { type: "image", image_url: "https://example.com/demo.png" },
            { type: "text", attrs: { content: "  First" } },
            { type: "br" },
            {
              type: "paragraph",
              children: [{ type: "text", text: "question  " }],
            },
          ],
        },
      }),
      JSON.stringify({ type: "session_info", name: "Structured title" }),
    ].join("\n"),
    "utf8",
  );

  assert.deepEqual(names.readSessionDisplayNameParts(sessionFile), {
    currentName: "Structured title",
    firstUserMessage: "First question",
  });
  assert.equal(
    names.readFirstUserMessageFromSessionFile(sessionFile),
    "First question",
  );

  await fs.rm(sessionDir, { recursive: true, force: true });
});

test("readSessionDisplayNameParts handles object-shaped rich message content", async () => {
  const sessionDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-session-names-"),
  );
  const sessionFile = path.join(sessionDir, "object-rich-content.jsonl");
  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: {
            type: "paragraph",
            children: [
              { type: "text", attrs: { content: "  Solo" } },
              { type: "br" },
              { type: "text", text: "message  " },
            ],
          },
        },
      }),
      JSON.stringify({ type: "session_info", name: "Object title" }),
    ].join("\n"),
    "utf8",
  );

  assert.deepEqual(names.readSessionDisplayNameParts(sessionFile), {
    currentName: "Object title",
    firstUserMessage: "Solo message",
  });

  await fs.rm(sessionDir, { recursive: true, force: true });
});

test("readSessionDisplayNameParts ignores blank later renames", async () => {
  const sessionDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-session-names-"),
  );
  const sessionFile = path.join(sessionDir, "blank-rename.jsonl");
  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({ type: "session_info", name: "Initial title" }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "First question" },
      }),
      JSON.stringify({ type: "session_info", name: "Renamed title" }),
      JSON.stringify({ type: "session_info", name: "   " }),
      "",
    ].join("\n"),
    "utf8",
  );

  assert.deepEqual(names.readSessionDisplayNameParts(sessionFile), {
    currentName: "Renamed title",
    firstUserMessage: "First question",
  });

  await fs.rm(sessionDir, { recursive: true, force: true });
});

test("readSessionDisplayNameParts keeps the first user message once captured", async () => {
  const sessionDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-session-names-"),
  );
  const sessionFile = path.join(sessionDir, "first-user-wins.jsonl");
  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "First question" },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "Second question" },
      }),
      JSON.stringify({ type: "session_info", name: "Renamed title" }),
    ].join("\n"),
    "utf8",
  );

  assert.deepEqual(names.readSessionDisplayNameParts(sessionFile), {
    currentName: "Renamed title",
    firstUserMessage: "First question",
  });

  await fs.rm(sessionDir, { recursive: true, force: true });
});

test("session display readers return empty parts for blank or missing paths", () => {
  assert.deepEqual(names.readSessionDisplayNameParts(""), {
    currentName: "",
    firstUserMessage: "",
  });
  assert.deepEqual(
    names.readSessionDisplayNameParts(path.join(os.tmpdir(), "missing.jsonl")),
    {
      currentName: "",
      firstUserMessage: "",
    },
  );
  assert.equal(names.readFirstUserMessageFromSessionFile(""), "");
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
