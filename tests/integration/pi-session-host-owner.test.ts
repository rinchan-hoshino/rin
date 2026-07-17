import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const host = await importBuiltModule<
  typeof import("../../src/core/pi/session-host.js")
>("dist/core/pi/session-host.js");

test("Pi session host reads and updates prompt state through the controlled seam", () => {
  const calls: string[] = [];
  const session: any = {
    _baseSystemPrompt: "base",
    _baseSystemPromptOptions: { cwd: "/workspace" },
    agent: {
      state: { systemPrompt: "agent" },
      setSystemPrompt(value: string) {
        calls.push(value);
      },
    },
    _toolRegistry: new Set(["read", "bash"]),
    _toolPromptSnippets: new Map([["read", "read files"]]),
    _toolPromptGuidelines: new Map([["read", new Set(["be exact"])]]),
  };

  assert.equal(host.readPiSessionBaseSystemPrompt(session), "base");
  assert.equal(
    host.readPiSessionBaseSystemPrompt({
      agent: { state: { systemPrompt: "agent" } },
    }),
    "agent",
  );
  assert.equal(host.readPiSessionBaseSystemPrompt({}), "");
  assert.deepEqual(host.readPiSessionBaseSystemPromptOptions(session), {
    cwd: "/workspace",
  });
  assert.deepEqual(host.readPiSessionBaseSystemPromptOptions({}, "/fallback"), {
    cwd: "/fallback",
  });
  assert.deepEqual(host.readPiSessionBaseSystemPromptOptions({}), {});
  assert.deepEqual(
    host.getPiSessionPromptToolState(session, ["read", "missing"]),
    {
      validToolNames: ["read"],
      toolSnippets: { read: "read files" },
      promptGuidelines: ["be exact"],
    },
  );

  host.writePiSessionBaseSystemPrompt(session, "updated");
  const minimal: any = {};
  host.writePiSessionBaseSystemPrompt(minimal, undefined as any);
  assert.equal(minimal._baseSystemPrompt, "");
  host.writePiSessionBaseSystemPrompt(null, "ignored");
  assert.equal(session._baseSystemPrompt, "updated");
  assert.equal(session.agent.state.systemPrompt, "updated");
  assert.deepEqual(calls, ["updated"]);
});

test("Pi session host normalizes resources, modes, auth, and extension context", async () => {
  const resourceLoader = {
    agentDir: "/agent",
    getSystemPrompt: () => "system",
    getAppendSystemPrompt: () => ["append"],
    getSkills: () => ({ skills: [{ name: "skill" }] }),
    getAgentsFiles: () => ({ agentsFiles: ["AGENTS.md"] }),
  };
  const session: any = {
    resourceLoader,
    extensionRunner: { mode: "rpc" },
    _extensionShutdownHandler: () => "closed",
    _extensionUIContext: { ui: true },
    _extensionCommandContextActions: { action: true },
    async _getCompactionRequestAuth(model: unknown) {
      return { apiKey: "key", headers: { model } };
    },
  };

  assert.deepEqual(host.getPiSessionResourcePromptState(session), {
    agentDir: "/agent",
    systemPrompt: "system",
    appendSystemPrompt: ["append"],
    skills: [{ name: "skill" }],
    agentsFiles: ["AGENTS.md"],
  });
  assert.deepEqual(
    host.getPiSessionResourcePromptState({
      _resourceLoader: {
        getAppendSystemPrompt: () => "invalid",
        getSkills: () => ({}),
        getAgentsFiles: () => ({}),
      },
    }),
    {
      agentDir: "",
      systemPrompt: "",
      appendSystemPrompt: [],
      skills: [],
      agentsFiles: [],
    },
  );
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
  assert.deepEqual(await host.getPiSessionCompactionRequestAuth(session, "m"), {
    apiKey: "key",
    headers: { model: "m" },
  });
  assert.deepEqual(await host.getPiSessionCompactionRequestAuth({}, "m"), {
    apiKey: undefined,
    headers: undefined,
  });
});

test("Pi session host binds, replaces, and invokes private semantic methods", () => {
  const calls: string[] = [];
  const session: any = {
    value: "bound",
    _rebuildSystemPrompt() {
      calls.push(`rebuild:${this.value}`);
      return 1;
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

  assert.equal(host.bindPiSessionSystemPromptRebuilder(session)?.(), 1);
  assert.equal(host.bindPiSessionCompactionChecker(session)?.(), 2);
  assert.equal(host.bindPiSessionAutoCompactor(session)?.("manual", false), 3);
  assert.equal(host.runPiSessionAutoCompaction(session, "retry", true), 3);
  assert.equal(host.bindPiSessionToolRegistryRefresher(session)?.(), 4);
  assert.equal(host.refreshPiSessionToolRegistry(session), 4);
  assert.equal(host.emitPiSessionEvent(session, { type: "done" }), 5);

  assert.equal(
    host.replacePiSessionSystemPromptRebuilder(session, () => 10),
    true,
  );
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
  assert.equal(
    host.replacePiSessionSystemPromptRebuilder(null, () => 0),
    false,
  );
  assert.equal(host.bindPiSessionSystemPromptRebuilder({}), undefined);
  assert.deepEqual(calls, [
    "rebuild:bound",
    "check",
    "compact:manual:false",
    "compact:retry:true",
    "refresh",
    "refresh",
    "emit:done",
  ]);
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
