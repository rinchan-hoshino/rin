import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const names = await importBuiltModule<
  typeof import("../../src/core/session/names.js")
>("dist/core/session/names.js");

test("session display names prefer rename, first message, then fallback", () => {
  assert.equal(
    names.resolveSessionDisplayName(
      { currentName: " Renamed ", firstUserMessage: "Question" },
      "fallback",
    ),
    "Renamed",
  );
  assert.equal(
    names.resolveSessionDisplayName(
      { currentName: " ", firstUserMessage: " Question " },
      "fallback",
    ),
    "Question",
  );
  assert.equal(names.resolveSessionDisplayName(null, " fallback "), "fallback");
  assert.equal(names.resolveSessionDisplayName(null), "");
  assert.equal(names.normalizeSessionNameDetail(" "), "");
  assert.equal(names.normalizeSessionNameDetail("abcd", 3), "ab…");
});

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
