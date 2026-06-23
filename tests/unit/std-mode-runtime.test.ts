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
const runtimeMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "runtime.js"))
    .href
);

async function pathExists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

test("configured session persists once a user starts a real conversation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-user-session-"));
  const agentDir = path.join(root, "agent");
  await fs.mkdir(agentDir, { recursive: true });

  const runtime = await runtimeMod.createConfiguredAgentSession({
    cwd: root,
    agentDir,
  });

  try {
    const manager = runtime.session.sessionManager;
    const sessionFile = manager.getSessionFile();
    manager._rewriteFile();
    assert.equal(await pathExists(sessionFile), false);

    manager.appendMessage({ role: "user", content: "hello" });
    assert.equal(await pathExists(sessionFile), true);
  } finally {
    await runtime.runtime?.dispose?.().catch?.(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("configured sessions forward Pi tool startup options", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-tool-options-"));
  const agentDir = path.join(root, "agent");
  await fs.mkdir(agentDir, { recursive: true });

  const runtime = await runtimeMod.createConfiguredAgentSession({
    cwd: root,
    agentDir,
    tools: ["read", "grep"],
    excludeTools: ["grep"],
    noTools: "builtin",
  });

  try {
    assert.deepEqual(runtime.session.getActiveToolNames(), ["read"]);
  } finally {
    await runtime.runtime?.dispose?.().catch?.(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("std configured session strips removed browse extension alias", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-std-runtime-"));
  const agentDir = path.join(root, "agent");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "settings.json"),
    `${JSON.stringify({ extensions: ["rin:browse"] })}\n`,
    "utf8",
  );

  const runtime = await runtimeMod.createConfiguredAgentSession({
    cwd: root,
    agentDir,
  });

  try {
    const session = runtime.session;
    assert.ok(session.getToolDefinition("recall"));
    assert.equal(session.getToolDefinition("browse"), undefined);
    assert.deepEqual(
      runtime.runtime?.session?.resourceLoader?.getExtensions?.()?.extensions ||
        [],
      [],
    );

    const memoryTool = session.getToolDefinition("recall");
    assert.equal(
      memoryTool.description,
      "Search archived session history by query, or browse recent sessions when query is omitted.",
    );
    assert.equal(
      memoryTool.promptSnippet,
      "Search archived session history for past-conversation evidence.",
    );
    assert.deepEqual(memoryTool.promptGuidelines, [
      "Use recall when past conversations, unfinished work, original wording, chronology, or cross-session continuity matters.",
    ]);

    const memoryResult = await memoryTool.execute(
      "tool-memory",
      { limit: 1 },
      undefined,
      undefined,
      {
        agentDir,
      },
    );
    assert.match(memoryResult.content[0].text, /recall recent/);
    assert.equal(memoryResult.details.emptyMessage, "No recall results found.");
  } finally {
    await runtime.runtime?.dispose?.().catch?.(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("std configured session registration does not require daemon-only tools to connect", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-std-daemonless-"));
  const agentDir = path.join(root, "agent");
  await fs.mkdir(agentDir, { recursive: true });

  const runtime = await runtimeMod.createConfiguredAgentSession({
    cwd: root,
    agentDir,
  });

  try {
    const session = runtime.session;
    for (const name of [
      "task_control",
      "fetch",
      "get_task",
      "save_task",
      "manage_task",
      "chat_bridge",
      "get_chat_msg",
      "list_chat_log",
      "save_chat_user_identity",
    ]) {
      assert.equal(
        session.getToolDefinition(name),
        undefined,
        `${name} should not register`,
      );
    }
  } finally {
    await runtime.runtime?.dispose?.().catch?.(() => {});
  }
});
