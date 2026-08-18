import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { importBuiltModule } from "../support/import-built-module.js";

const host = await importBuiltModule<
  typeof import("../../src/core/pi/session-host.js")
>("dist/core/pi/session-host.js");

test("Pi session host normalizes modes, auth, and extension context", async () => {
  const session: any = {
    extensionRunner: { mode: "rpc" },
    _extensionShutdownHandler: () => "closed",
    _extensionUIContext: { ui: true },
    _extensionCommandContextActions: { action: true },
  };

  assert.equal(
    host.getPiExtensionRunner({ _extensionRunner: "private" }),
    "private",
  );
  assert.equal(host.getPiSessionExtensionMode(session), "rpc");
  assert.equal(
    host.getPiSessionExtensionMode({ _extensionMode: "json" }),
    "json",
  );
  assert.equal(
    host.getPiSessionExtensionMode({ _extensionMode: "invalid" }),
    "print",
  );
  assert.equal(host.shutdownPiSessionExtensionHost(session), "closed");
  assert.deepEqual(host.getPiSessionExtensionUIContext(session), { ui: true });
  assert.deepEqual(host.getPiSessionExtensionCommandContextActions(session), {
    action: true,
  });
});

test("Pi session host clears failed active-tool reload requests", async () => {
  const session: any = {
    async reload() {
      throw new Error("reload failed");
    },
    setActiveToolsByName() {
      throw new Error("stale active-tool request survived");
    },
  };

  await assert.rejects(
    () => host.reloadPiSessionWithActiveTools(session, ["read"]),
    /reload failed/,
  );
  assert.equal(host.restorePiSessionActiveToolsForReload(session), false);
  await assert.rejects(
    () => host.reloadPiSessionWithActiveTools({}, ["read"]),
    /Active tool changes require session reload/,
  );
});

test("Pi session host sparse private boundaries remain inert", () => {
  assert.equal(host.bindPiSessionCompactionChecker(null), undefined);
  assert.equal(
    host.replacePiSessionCompactionChecker(null, () => 1),
    false,
  );
  assert.equal(
    host.replacePiSessionCompactionChecker("scalar", () => 1),
    false,
  );
  assert.equal(host.runPiSessionAutoCompaction({}, "manual", false), undefined);
  assert.equal(host.refreshPiSessionToolRegistry({}), undefined);
  assert.equal(host.buildRinCompactionRequest(null), null);
  assert.deepEqual(
    host.buildRinCompactionRequest({
      preparation: {
        isSplitTurn: true,
        messagesToSummarize: null,
        turnPrefixMessages: null,
      },
      customInstructions: "   ",
    }),
    {
      preparation: {
        isSplitTurn: true,
        messagesToSummarize: null,
        turnPrefixMessages: null,
      },
      customInstructions: host.RIN_COMPACTION_INSTRUCTIONS,
    },
  );
});

test("Pi session host binds, replaces, and invokes private semantic methods", () => {
  const calls: string[] = [];
  const session: any = {
    value: "bound",
    agent: {
      transformContext: async (messages: any[]) => messages,
      setSystemPrompt(systemPrompt: string) {
        calls.push(`prompt:${systemPrompt}`);
      },
    },
    _baseSystemPrompt: "pi",
    _baseSystemPromptOptions: { cwd: "/workspace" },
    _rebuildSystemPrompt() {
      calls.push("rebuild");
      return "rebuilt";
    },
    _checkCompaction() {
      calls.push("check");
      return 2;
    },
    _runAutoCompaction(reason: string, retry: boolean) {
      calls.push(`compact:${reason}:${retry}`);
      return 3;
    },
    _refreshToolRegistry() {
      calls.push("refresh");
      return 4;
    },
    _emit(event: any) {
      calls.push(`emit:${event.type}`);
      return 5;
    },
  };

  assert.equal(host.bindPiSessionSystemPromptRebuilder(session)?.(), "rebuilt");
  assert.equal(host.bindPiSessionCompactionChecker(session)?.(), 2);
  assert.equal(host.bindPiSessionAutoCompactor(session)?.("manual", false), 3);
  assert.equal(host.runPiSessionAutoCompaction(session, "retry", true), 3);
  assert.equal(host.bindPiSessionToolRegistryRefresher(session)?.(), 4);
  assert.equal(host.refreshPiSessionToolRegistry(session), 4);
  assert.equal(host.emitPiSessionEvent(session, { type: "done" }), 5);

  assert.equal(
    host.replacePiSessionSystemPromptRebuilder(session, () => "rin"),
    true,
  );
  host.writePiSessionBaseSystemPrompt(session, "Rin prompt");
  assert.equal(session._baseSystemPrompt, "Rin prompt");
  assert.equal(
    host.replacePiSessionCompactionChecker(session, () => 20),
    true,
  );
  assert.equal(
    host.replacePiSessionAutoCompactor(session, () => 30),
    true,
  );
  assert.equal(
    host.replacePiSessionToolRegistryRefresher(session, () => 40),
    true,
  );
  assert.deepEqual(calls, [
    "rebuild",
    "check",
    "compact:manual:false",
    "compact:retry:true",
    "refresh",
    "refresh",
    "emit:done",
    "prompt:Rin prompt",
  ]);
});

test("Pi session host owns compaction without registering core extension handlers", async () => {
  const events: any[] = [];
  const appended: any[] = [];
  const pathEntries = [
    {
      id: "u1",
      parentId: null,
      type: "message",
      message: { role: "user", content: "old request", timestamp: 1 },
    },
    {
      id: "a1",
      parentId: "u1",
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "old answer" }],
        stopReason: "stop",
        timestamp: 2,
      },
    },
    {
      id: "u2",
      parentId: "a1",
      type: "message",
      message: { role: "user", content: "recent request", timestamp: 3 },
    },
  ];
  const compactionEntry = {
    id: "c1",
    type: "compaction",
    summary: "Rin summary",
  };
  let coreCalls = 0;
  const runner: any = {
    hasHandlers: () => false,
    async emit(event: any) {
      events.push(event);
      return undefined;
    },
  };
  const session: any = {
    model: { provider: "test", id: "model" },
    extensionRunner: runner,
    agent: {
      state: { messages: pathEntries.map((entry) => entry.message) },
      hasQueuedMessages: () => false,
    },
    abort: async () => {},
    _emit(event: any) {
      events.push(event);
    },
    _runAutoCompaction: async () => false,
    settingsManager: {
      getCompactionSettings: () => ({ keepRecentTokens: 1 }),
    },
    sessionManager: {
      getBranch: () => pathEntries,
      appendCompaction(...args: any[]) {
        appended.push(args);
      },
      getEntries: () => [...pathEntries, compactionEntry],
      buildSessionContext: () => ({
        messages: [{ role: "user", content: "recent request" }],
      }),
    },
  };

  assert.equal(
    host.installPiSessionCompactionOwner(session, async (event: any) => {
      coreCalls += 1;
      assert.equal(event.type, "session_before_compact");
      assert.equal(event.customInstructions, "focus");
      return {
        summary: "Rin summary",
        firstKeptEntryId: "u2",
        tokensBefore: 10,
        details: {},
      };
    }),
    true,
  );
  const result = await session.compact("focus");

  assert.equal(coreCalls, 1);
  assert.equal(result.summary, "Rin summary");
  assert.equal(appended[0][4], false);
  assert.equal(runner.hasHandlers("session_before_compact"), false);
  assert.equal(
    events.some((event) => event.type === "session_compact"),
    true,
  );

  runner.hasHandlers = (type: string) => type === "session_before_compact";
  runner.emit = async (event: any) => {
    events.push(event);
    if (event.type !== "session_before_compact") return undefined;
    return {
      compaction: {
        summary: "Extension summary",
        firstKeptEntryId: "u2",
        tokensBefore: 11,
        details: {},
      },
    };
  };
  const extensionResult = await session.compact("extension first");
  assert.equal(extensionResult.summary, "Extension summary");
  assert.equal(coreCalls, 1);
  assert.equal(appended[1][4], true);
});

test("Pi session host seeds only non-persisted managers", () => {
  const manager = SessionManager.inMemory("/workspace", {
    id: "019fad2a-b02a-74cc-9d03-56b909f1f929",
  });
  host.seedPiInMemorySessionManager(manager, [
    {
      type: "custom_message",
      id: "context1",
      parentId: null,
      timestamp: "2026-08-11T00:00:00.000Z",
      customType: "test",
      content: "context",
      display: false,
    },
  ]);
  assert.equal(manager.getLeafId(), "context1");
  assert.equal(manager.buildSessionContext().messages.length, 1);
  assert.throws(
    () =>
      host.seedPiInMemorySessionManager(
        { isPersisted: () => true, getHeader: () => ({}) },
        [],
      ),
    /Pi session seeding requires a non-persisted manager/,
  );
  assert.throws(
    () =>
      host.seedPiInMemorySessionManager(
        { isPersisted: () => false, getHeader: () => null },
        [],
      ),
    /Pi session seeding requires a session header/,
  );
});

test("Pi session manager persistence patch creates and indexes conversation files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-session-host-"));
  const sessionFile = path.join(dir, "session.jsonl");
  const calls: string[] = [];
  const manager: any = {
    sessionFile,
    flushed: true,
    fileEntries: [],
    isPersisted: () => true,
    getSessionDir: () => dir,
    _rewriteFile() {
      calls.push("rewrite");
      return "rewritten";
    },
    _persist() {
      calls.push("persist");
      return "persisted";
    },
    _buildIndex() {
      return "index";
    },
  };

  try {
    host.patchPiSessionManagerConversationPersistence(manager);
    host.patchPiSessionManagerConversationPersistence(manager);
    assert.equal(manager._rewriteFile(), undefined);
    assert.equal(manager.flushed, false);

    manager.fileEntries = [
      {
        type: "session",
        version: 3,
        id: "session-id",
        timestamp: "2026-07-16T00:00:00.000Z",
        cwd: dir,
      },
      {
        type: "message",
        id: "message-id",
        timestamp: "2026-07-16T00:00:01.000Z",
        message: { role: "user", content: "hello" },
      },
    ];
    assert.equal(manager._persist(), "persisted");
    assert.equal(manager.flushed, true);
    assert.deepEqual(calls, ["persist", "rewrite"]);
    assert.equal(
      host.bindPiSessionManagerFileRewriter(manager)?.(),
      "rewritten",
    );
    assert.equal(host.rewritePiSessionManagerFile(manager), "rewritten");
    assert.equal(host.buildPiSessionManagerIndex(manager), "index");
    assert.equal(host.buildPiSessionManagerIndex({}), undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
