import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const promptContextMod = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-frontend-sdk", "prompt-context.js"),
  ).href
);

test("chat prompt context keeps adapter-provided runtime metadata in the system prompt block", () => {
  const meta = {
    source: "chat-bridge",
    chatKey: "example:private:repo#issue/361",
    chatName: "Example Issue #361",
    runtimeMetadata: {
      "source repo": "owner/project",
      "source target": "issue #361",
      "source url": "https://example.invalid/owner/project/issues/361",
      "source event": "issue_comment",
    },
  };
  const promptText = promptContextMod.formatPromptContext(
    meta,
    "owner comment",
  );
  const systemBlock =
    promptContextMod.formatPromptContextSystemPromptBlock(meta);

  assert.equal(promptText, "owner comment");
  assert.ok(systemBlock.includes("- source repo: owner/project"));
  assert.ok(systemBlock.includes("- source target: issue #361"));
  assert.ok(
    systemBlock.includes(
      "- source url: https://example.invalid/owner/project/issues/361",
    ),
  );
  assert.ok(systemBlock.includes("- source event: issue_comment"));
  assert.ok(systemBlock.includes("Chat binding context:"));
  assert.equal(systemBlock.includes("runtime note:"), false);
});

test("scheduled chat-bound prompt context renders task and chat binding blocks", () => {
  const meta = {
    source: "scheduled-task",
    chatKey: "telegram/demo:1",
    taskId: "cron_demo",
    taskName: "Demo Task",
    taskContextKind: "scheduled-task",
  };
  const promptText = promptContextMod.formatPromptContext(
    meta,
    "scheduled hello",
  );
  const systemBlock =
    promptContextMod.formatPromptContextSystemPromptBlock(meta);

  assert.equal(promptText, "scheduled hello");
  assert.equal(systemBlock.includes("chat trigger:"), false);
  assert.equal(systemBlock.includes("task run id:"), false);
  assert.equal(systemBlock.includes("task session mode:"), false);
  assert.ok(systemBlock.includes("Scheduled task context:"));
  assert.ok(systemBlock.includes("- task id: cron_demo"));
  assert.ok(systemBlock.includes("- task name: Demo Task"));
  assert.ok(systemBlock.includes("Chat binding context:"));
  assert.ok(systemBlock.includes("- chatKey: telegram/demo:1"));
  assert.equal(systemBlock.includes("runtime note:"), false);
  assert.equal(systemBlock.includes("operational rule:"), false);
  assert.equal(systemBlock.includes("Chat context:"), false);
  assert.equal(systemBlock.includes("sender user id:"), false);
  assert.equal(systemBlock.includes("sender nickname:"), false);
  assert.equal(promptText.includes("time:"), false);
});
