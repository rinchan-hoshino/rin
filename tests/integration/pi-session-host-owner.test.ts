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
await import("./pi-session-host.test.js");

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

test("Pi session host binds, replaces, and invokes private semantic methods", () => {
  const calls: string[] = [];
  const session: any = {
    value: "bound",
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

  assert.equal(host.bindPiSessionCompactionChecker(session)?.(), 2);
  assert.equal(host.bindPiSessionAutoCompactor(session)?.("manual", false), 3);
  assert.equal(host.runPiSessionAutoCompaction(session, "retry", true), 3);
  assert.equal(host.bindPiSessionToolRegistryRefresher(session)?.(), 4);
  assert.equal(host.refreshPiSessionToolRegistry(session), 4);
  assert.equal(host.emitPiSessionEvent(session, { type: "done" }), 5);

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
    "check",
    "compact:manual:false",
    "compact:retry:true",
    "refresh",
    "refresh",
    "emit:done",
  ]);
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
