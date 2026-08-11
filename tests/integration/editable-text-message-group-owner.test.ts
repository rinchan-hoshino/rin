import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const { EditableTextMessageGroup } = await importBuiltModule<
  typeof import("../../src/core/chat-runtime/editable-text-message-group.js")
>("dist/core/chat-runtime/editable-text-message-group.js");

async function fixture(overrides: Record<string, unknown> = {}) {
  const cacheDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-editable-owner-"),
  );
  const calls = {
    sent: [] as any[],
    edited: [] as any[],
    deleted: [] as any[],
  };
  let nextId = 0;
  const group = new EditableTextMessageGroup({
    cacheDir,
    cacheScope: "owner/scope",
    maxTextLength: 6,
    workingText: "Wait",
    progressTexts: ["Wait", "Think"],
    sendText: async (input) => {
      calls.sent.push(input);
      nextId += 1;
      return `sent-${nextId}`;
    },
    editText: async (input) => {
      calls.edited.push(input);
      return input.messageId;
    },
    deleteMessage: async (input) => {
      calls.deleted.push(input);
    },
    ...overrides,
  } as any);
  return { cacheDir, calls, group };
}

test("editable text owner sends, edits, chunks, and finalizes one durable group", async () => {
  const { cacheDir, calls, group } = await fixture({
    chunkText: (text: string) =>
      text.length > 8 ? [text.slice(0, 8), text.slice(8)] : [text],
  });
  try {
    assert.deepEqual(await group.updateText({ chatId: "", text: "x" }), []);
    assert.deepEqual(await group.updateText({ chatId: "chat", text: "" }), []);

    const first = await group.updateText({
      chatId: "chat",
      replyToMessageId: "reply",
      text: "working",
      kind: "working",
      todoText: "todo",
    });
    assert.equal(first.length, 2);
    assert.equal(calls.sent[0].replyToMessageId, "reply");
    assert.equal(calls.sent[1].replyToMessageId, undefined);

    const duplicate = await group.updateText({
      chatId: "chat",
      replyToMessageId: "reply",
      text: "working",
      kind: "working",
      todoText: "todo",
    });
    assert.deepEqual(duplicate, first);
    assert.equal(calls.edited.length, 0);

    const edited = await group.updateText({
      chatId: "chat",
      replyToMessageId: "reply",
      text: "final answer",
      kind: "final",
      finalize: true,
    });
    assert.ok(edited.length > 0);
    assert.ok(calls.edited.length > 0);

    const blocked = await group.updateText({
      chatId: "chat",
      replyToMessageId: "reply",
      text: "late progress",
    });
    assert.deepEqual(blocked, []);
    assert.equal(await group.deleteProgress("chat", "reply"), false);
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});

test("editable working indicator retires the previous quoted presentation on ownership transfer", async () => {
  const { cacheDir, calls, group } = await fixture();
  try {
    const indicator = group.indicator();
    assert.equal(
      await indicator.tick({
        chatId: "chat",
        replyToMessageId: "old-owner-message",
        workingStatusText: "Working",
      }),
      true,
    );

    assert.equal(
      await indicator.end({
        chatId: "chat",
        replyToMessageId: "old-owner-message",
        endReason: "presentation_transferred",
      }),
      true,
    );
    assert.deepEqual(
      calls.deleted.map((call) => call.messageId),
      calls.sent.map((_, index) => `sent-${index + 1}`),
    );
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});

test("editable text owner recovers from stale edits and cleans surplus messages", async () => {
  let failEdit = false;
  const { cacheDir, calls, group } = await fixture({
    maxTextLength: 3,
    editText: async (input: any) => {
      calls.edited.push(input);
      if (failEdit) throw new Error("message_not_found");
      return [input.messageId];
    },
    repeatReplyToMessageId: true,
  });
  try {
    const ids = await group.updateText({
      chatId: "chat",
      replyToMessageId: "reply",
      textChunks: ["abcdefghi"],
      kind: "working",
    });
    assert.equal(ids.length, 3);
    assert.ok(calls.sent.every((call) => call.replyToMessageId === "reply"));

    await group.updateText({
      chatId: "chat",
      replyToMessageId: "reply",
      text: "a",
      kind: "working",
    });
    assert.equal(calls.deleted.length, 2);

    failEdit = true;
    const recovered = await group.updateText({
      chatId: "chat",
      replyToMessageId: "reply",
      text: "replacement",
      kind: "working",
    });
    assert.ok(recovered.every((id) => id.startsWith("sent-")));
    assert.ok(calls.deleted.length >= 3);
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});

test("editable text owner propagates fatal edit failures and tolerates delivery cleanup failures", async () => {
  let mode = "ok";
  const { cacheDir, group } = await fixture({
    editText: async (input: any) => {
      if (mode === "fatal") throw new Error("permission denied");
      if (mode === "recover") throw new Error("cannot edit message");
      return input.messageId;
    },
    deleteMessage: async () => {
      throw new Error("delete failed");
    },
    isRecoverableEditError: (error: any) => error?.message === "custom stale",
  });
  try {
    await group.updateText({
      chatId: "chat",
      text: "progress",
      kind: "working",
    });
    mode = "fatal";
    await assert.rejects(
      () =>
        group.updateText({ chatId: "chat", text: "fatal", kind: "working" }),
      /permission denied/,
    );
    mode = "recover";
    assert.ok(
      (
        await group.updateText({
          chatId: "chat",
          text: "recover",
          kind: "working",
        })
      ).length,
    );
    assert.equal(
      await group.deleteProgress("chat", undefined, "", {
        markFinalizing: false,
      }),
      true,
    );
    assert.equal(await group.deleteProgress("chat"), false);
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});

test("editable text owner covers fallback copy, empty delivery, override keys, and legacy state", async () => {
  const cacheDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-editable-fallback-"),
  );
  const sent: any[] = [];
  const group = new EditableTextMessageGroup({
    cacheDir,
    cacheScope: "",
    maxTextLength: 20,
    progressTexts: [],
    chunkText: (text) => (text === "drop" ? [] : [text]),
    sendText: async (input) => {
      sent.push(input);
      return input.text === "empty delivery" ? [] : ["owner-id", ""];
    },
    editText: async () => [],
    deleteMessage: async () => undefined,
    isRecoverableEditError: (error: any) => error?.message === "custom stale",
  });
  try {
    assert.deepEqual(
      await group.updateText({ chatId: "room", text: "drop", key: "override" }),
      [],
    );
    assert.deepEqual(
      await group.updateText({
        chatId: "room",
        text: "empty delivery",
        key: "empty-key",
      }),
      [],
    );
    const ids = await group.updateText({
      chatId: "room",
      text: "answer",
      key: "override",
      todoTextChunks: ["todo chunk"],
    });
    assert.deepEqual(ids, ["owner-id"]);
    assert.equal(sent.at(-1).replyToMessageId, undefined);

    const finalWithoutProgress = await group.updateText({
      chatId: "fresh",
      text: "fresh final",
      finalize: true,
    });
    assert.deepEqual(finalWithoutProgress, ["owner-id"]);

    const legacyDir = path.join(cacheDir, "working-messages", "default");
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(
      path.join(legacyDir, "legacy.json"),
      JSON.stringify({
        messageId: "legacy-id",
        text: "... Working...",
        kind: "",
      }),
    );
    assert.equal(
      await group.deleteProgress("room", undefined, "legacy", {
        markFinalizing: false,
      }),
      true,
    );
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});

test("editable polling indicator reflects status and removes only progress artifacts", async () => {
  const { cacheDir, calls, group } = await fixture({
    workingText: "Owner working",
  });
  try {
    const indicator = group.indicator();
    assert.equal(indicator.type, "polling");
    assert.equal(await indicator.tick({}), false);
    assert.equal(await indicator.end({}), false);
    assert.equal(
      await indicator.tick({
        chatId: "room",
        workingStatusText: " status ",
        assistantSummaryText: "summary",
        tick: 1,
        replyToMessageId: "reply",
        todoNoticeText: "task",
      }),
      true,
    );
    assert.match(calls.sent.map((call) => call.text).join(""), /status/);
    assert.equal(
      await indicator.end({ chatId: "room", messageId: "reply" }),
      false,
    );

    assert.equal(
      await indicator.tick({
        chatId: "other",
        assistantSummaryText: "summary",
        tick: 0,
      }),
      true,
    );
    assert.equal(await indicator.end({ chatId: "other" }), false);
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});

test("extension presentation applies each static Working text and resets to Working...", async () => {
  const { cacheDir, calls, group } = await fixture({ maxTextLength: 2_000 });
  try {
    const indicator = group.indicator();
    group.setWorkingText("Localized A");
    await indicator.tick({ chatId: "chat", tick: 0 });
    await indicator.tick({ chatId: "chat", tick: 1 });
    assert.match(calls.sent.at(-1).text, /Localized A/);
    assert.equal(calls.edited.length, 0);

    group.setWorkingText("Localized B");
    await indicator.tick({ chatId: "chat", tick: 2 });
    await indicator.tick({ chatId: "chat", tick: 3 });
    assert.equal(calls.edited.at(-1).text, "... Localized B");
    assert.equal(calls.edited.length, 1);

    group.setWorkingText("");
    await indicator.tick({ chatId: "chat", tick: 4 });
    assert.equal(calls.edited.at(-1).text, "... Working...");
    assert.equal(calls.edited.length, 2);
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});
