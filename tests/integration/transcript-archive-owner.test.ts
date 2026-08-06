import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as archive from "../../dist/core/memory/transcript-archive.js";

async function withTempDir(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-transcript-owner-"),
  );
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: "entry-1",
    timestamp: "2026-04-05T12:22:24.000Z",
    sessionId: "session-1",
    sessionFile: "/tmp/session-1.jsonl",
    role: "assistant",
    text: "owner transcript message with enough detail",
    ...overrides,
  } as any;
}

test("transcript archive resolves roots and stable archive paths", () => {
  const previousRinDir = process.env.RIN_DIR;
  try {
    process.env.RIN_DIR = "/tmp/owner-default-root";
    assert.match(
      archive.resolveTranscriptRoot(),
      /owner-default-root[\\/]memory[\\/]transcripts$/,
    );
    assert.match(
      archive.resolveTranscriptSearchDbPath(),
      /owner-default-root[\\/]memory[\\/]search\.db$/,
    );
  } finally {
    if (previousRinDir === undefined) delete process.env.RIN_DIR;
    else process.env.RIN_DIR = previousRinDir;
  }
  assert.match(
    archive.resolveTranscriptRoot("/tmp/owner-root"),
    /owner-root[\\/]memory[\\/]transcripts$/,
  );
  assert.match(
    archive.resolveTranscriptSearchDbPath("/tmp/owner-root"),
    /owner-root[\\/]memory[\\/]search\.db$/,
  );
  assert.match(
    archive.getTranscriptArchivePath(
      { timestamp: "2026-04-05T12:22:24.000Z", sessionId: "session-1" },
      "/tmp/owner-root",
    ),
    /2026[\\/]04[\\/]session-1\.jsonl$/,
  );
  assert.match(
    archive.getTranscriptArchivePath("nested/demo.jsonl", "/tmp/owner-root"),
    /transcripts[\\/]nested[\\/]demo\.jsonl$/,
  );
  assert.match(
    archive.getTranscriptArchivePath("session-key", "/tmp/owner-root"),
    /unknown[\\/]session-key\.jsonl$/,
  );
  assert.match(
    archive.getTranscriptArchivePath("/tmp/source-session", "/tmp/owner-root"),
    /unknown[\\/][0-9a-f]{16}\.jsonl$/,
  );
  assert.match(
    archive.getTranscriptArchivePath("", "/tmp/owner-root"),
    /unknown[\\/]unknown-session\.jsonl$/,
  );
  assert.match(
    archive.getTranscriptArchivePath(
      { sessionFile: "/tmp/source.jsonl", timestamp: "invalid" },
      "/tmp/owner-root",
    ),
    /[0-9]{4}[\\/][0-9]{2}[\\/][0-9a-f]{16}\.jsonl$/,
  );
  assert.match(
    archive.getTranscriptArchivePath({}, "/tmp/owner-root"),
    /unknown-session\.jsonl$/,
  );
});

test("transcript text extraction covers structured, shell, summary, and fallback content", () => {
  const circular: any = {};
  circular.self = circular;
  assert.equal(
    archive.extractTranscriptText({ role: "user", content: " hello " }),
    "hello",
  );
  const structured = archive.extractTranscriptText({
    role: "assistant",
    content: [
      { type: "text", text: "answer" },
      { type: "thinking", thinking: "reason" },
      { type: "toolCall", name: "read", args: { path: "/tmp/a" } },
      { type: "toolCall", name: "number", args: 42 },
      { type: "toolCall", name: "boolean", args: true },
      { type: "toolCall", name: "string", args: " value " },
      { type: "toolCall", toolName: "write", arguments: circular },
      { type: "toolCall" },
      { type: "image", mimeType: "image/png" },
      { type: "image", mimeType: "" },
      { type: "file", name: "note.txt" },
      { type: "file", path: "/tmp/by-path.txt" },
      { type: "file", url: "https://example.test/by-url.txt" },
      { type: "unknown" },
      null,
    ],
  });
  assert.match(structured, /^answer\nreason/m);
  assert.match(structured, /\[tool:read\].*\/tmp\/a/);
  assert.match(structured, /\[tool:write\]/);
  assert.match(structured, /\[tool:tool\]/);
  assert.match(structured, /\[image:image\/png\]/);
  assert.match(structured, /\[file:note\.txt\]/);
  assert.equal(
    archive.extractTranscriptText({
      role: "bashExecution",
      command: " pwd ",
      output: " /tmp ",
    }),
    "[bash] pwd\n\n/tmp",
  );
  assert.equal(
    archive.extractTranscriptText({
      role: "bashExecution",
      output: "only output",
    }),
    "only output",
  );
  assert.equal(
    archive.extractTranscriptText({
      role: "branchSummary",
      summary: " summary ",
    }),
    "summary",
  );
  assert.equal(
    archive.extractTranscriptText({
      role: "compactionSummary",
      summary: " compact ",
    }),
    "compact",
  );
  assert.equal(
    archive.extractTranscriptText({ role: "custom", text: " fallback " }),
    "fallback",
  );
});

test("transcript append rejects incomplete records and persists complete metadata", async () => {
  await withTempDir(async (root) => {
    assert.equal(
      await archive.appendTranscriptArchiveRecord({}, root),
      undefined,
    );
    assert.equal(
      await archive.appendTranscriptArchiveRecord(
        { role: "sessionSummary", sessionFile: "/tmp/a", text: "legacy" },
        root,
      ),
      undefined,
    );
    assert.equal(
      await archive.appendTranscriptArchiveRecord(
        { role: "assistant", text: "ephemeral" },
        root,
      ),
      undefined,
    );
    assert.equal(
      await archive.appendTranscriptArchiveRecord(
        { role: "assistant", sessionFile: "/tmp/a" },
        root,
      ),
      undefined,
    );

    const written = await archive.appendTranscriptArchiveRecord(
      {
        timestamp: "2026-04-05T12:22:24.000Z",
        sessionId: "session-1",
        sessionFile: "/tmp/session-1.jsonl",
        role: "assistant",
        content: [{ type: "text", text: "saved owner response" }],
        toolName: "read",
        toolCallId: "call-1",
        customType: "owner",
        stopReason: "stop",
        errorMessage: "none",
        provider: "owner-provider",
        model: "owner-model",
        display: false,
      },
      root,
    );
    assert.ok(written);
    assert.equal(written?.entry.text, "saved owner response");
    assert.equal(written?.entry.display, false);
    assert.equal(written?.fileState.archivePath, written?.filePath);
    assert.ok((written?.fileState.size ?? 0) > 0);

    const generatedId = await archive.appendTranscriptArchiveRecord(
      {
        timestamp: "2026-04-05T12:22:25.000Z",
        sessionFile: "/tmp/session-2.jsonl",
        role: "user",
        text: "generated id",
      },
      root,
    );
    assert.match(generatedId?.entry.id ?? "", /^[0-9a-f]{16}$/);
  });
});

test("transcript files load recursively while discarding malformed and legacy rows", async () => {
  await withTempDir(async (root) => {
    const nested = path.join(root, "memory", "transcripts", "2026", "04");
    await fs.mkdir(nested, { recursive: true });
    const file = path.join(nested, "session.jsonl");
    await fs.writeFile(
      file,
      [
        JSON.stringify(entry({ id: "text-present" })),
        JSON.stringify({
          ...entry({ id: "text-derived" }),
          text: "",
          content: [{ type: "text", text: "derived text" }],
        }),
        JSON.stringify(entry({ id: "legacy", customType: "session_summary" })),
        "not json",
        "",
      ].join("\n"),
    );
    const loaded = await archive.loadTranscriptArchiveFile(file);
    assert.deepEqual(
      loaded.map((item) => item.id),
      ["text-present", "text-derived"],
    );
    assert.equal(loaded[1].text, "derived text");
    assert.equal(loaded[0].archiveLine, 1);
    assert.equal(loaded[0].archivePath, file);
    assert.deepEqual(
      await archive.loadTranscriptArchiveFile(path.join(root, "missing.jsonl")),
      [],
    );

    await fs.writeFile(path.join(nested, "ignored.txt"), "ignored");
    const files = await archive.collectTranscriptFiles(
      path.join(root, "memory", "transcripts"),
    );
    assert.deepEqual(files, [file]);
    assert.deepEqual(
      await archive.collectTranscriptFiles(path.join(root, "missing")),
      [],
    );
    const all = await archive.loadTranscriptArchiveEntries(root);
    assert.equal(all.length, 2);
  });
});

test("session presentation ranks useful messages and preserves newest timestamp", () => {
  const entries = [
    entry({
      id: "assistant-tool",
      toolName: "browser_click",
      text: '[tool:browser_click] {"selector":"Next"}\nCaptcha remains',
      timestamp: "2026-04-05T12:22:24.000Z",
      archiveLine: 4,
    }),
    entry({
      id: "new-tool",
      role: "toolResult",
      toolName: "read",
      text: "newer output",
      timestamp: "2026-04-05T12:22:25.000Z",
      archiveLine: 5,
    }),
    entry({
      id: "user",
      role: "user",
      toolName: undefined,
      text: "User request with a useful long path /tmp/a",
      timestamp: "2026-04-05T12:22:22.000Z",
      archiveLine: 2,
    }),
    entry({
      id: "custom",
      role: "custom",
      customType: "notice",
      toolName: undefined,
      text: "custom notice",
      timestamp: "invalid",
      archiveLine: 0,
    }),
  ];
  const result = archive.presentSessionResult(entries, 7, "/tmp/root");
  assert.equal(result.id, "session-1");
  assert.equal(result.role, "assistant");
  assert.equal(result.timestamp, "2026-04-05T12:22:25.000Z");
  assert.match(result.preview, /browser_click/);
  assert.equal(result.messages[0].id, "assistant-tool");
  assert.ok(result.messages.length <= archive.MAX_MATCHED_ENTRIES_PER_SESSION);
  assert.match(
    archive.transcriptPreviewText(entries[0]),
    /^\[assistant:browser_click\]/,
  );
  assert.match(archive.transcriptPreviewText(entries[3]), /^\[custom:notice\]/);
  assert.equal(archive.sessionGroupingKey(entries[0]), "/tmp/session-1.jsonl");
  assert.equal(archive.sessionGroupingKey({ sessionId: "only-id" }), "only-id");
  assert.equal(archive.sessionGroupingKey({ id: "entry-id" }), "entry-id");

  const message = archive.buildResultMessage(
    entry({ text: "  many   spaces  ", archiveLine: 0, toolName: "" }),
  );
  assert.equal(message.line, 1);
  assert.equal(message.text, "many spaces");
  assert.equal(message.toolName, undefined);

  const supplied = [
    {
      id: "supplied",
      role: "assistant",
      timestamp: "now",
      line: 8,
      text: "supplied",
    },
  ];
  assert.deepEqual(
    archive.presentSessionResult([entry()], 1, "", {
      hitCount: 4,
      messages: supplied,
    }).messages,
    supplied,
  );

  const fallback = archive.presentSessionResult(
    [
      entry({
        id: "bash",
        sessionId: "",
        sessionFile: "",
        role: "bashExecution",
        text: "[bash] pwd http://example.test/path",
        toolName: undefined,
        toolCallId: "call-bash",
      }),
      entry({
        id: "empty",
        sessionId: "",
        sessionFile: "",
        role: "custom",
        text: "",
        timestamp: "2026-04-05T12:22:20.000Z",
      }),
    ],
    2,
    "/tmp/root",
    { messages: [] },
  );
  assert.equal(fallback.id, "bash");
  assert.ok(fallback.name.length > 0);
  assert.match(fallback.path, /memory[\\/]transcripts/);
});

test("legacy summary detection recognizes either historical marker", () => {
  assert.equal(
    archive.isLegacySyntheticSessionSummaryEntry({ role: "sessionSummary" }),
    true,
  );
  assert.equal(
    archive.isLegacySyntheticSessionSummaryEntry({
      customType: "session_summary",
    }),
    true,
  );
  assert.equal(
    archive.isLegacySyntheticSessionSummaryEntry({ role: "assistant" }),
    false,
  );
});
