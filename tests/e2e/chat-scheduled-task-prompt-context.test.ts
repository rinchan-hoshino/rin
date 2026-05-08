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
    path.join(rootDir, "dist", "core", "chat-bridge", "prompt-context.js"),
  ).href
);

test("chat prompt context keeps adapter-provided runtime metadata in the ordinary chat header", () => {
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

  assert.ok(promptText.includes("source repo: owner/project"));
  assert.ok(promptText.includes("source target: issue #361"));
  assert.ok(
    promptText.includes(
      "source url: https://example.invalid/owner/project/issues/361",
    ),
  );
  assert.ok(promptText.includes("source event: issue_comment"));
  assert.ok(systemBlock.includes("- source repo: owner/project"));
  assert.ok(systemBlock.includes("- source target: issue #361"));
  assert.ok(promptText.endsWith("---\nowner comment"));
});

test("scheduled chat-bound prompt context keeps chat and task metadata in the prompt header", () => {
  const meta = {
    source: "chat-bridge",
    chatKey: "telegram/demo:1",
    taskId: "cron_demo",
    taskName: "Demo Task",
  };
  const promptText = promptContextMod.formatPromptContext(
    meta,
    "scheduled hello",
  );
  const systemBlock =
    promptContextMod.formatPromptContextSystemPromptBlock(meta);

  assert.ok(promptText.includes("chatKey: telegram/demo:1"));
  assert.equal(promptText.includes("chat trigger:"), false);
  assert.ok(promptText.includes("task id: cron_demo"));
  assert.equal(promptText.includes("task run id:"), false);
  assert.equal(promptText.includes("task session mode:"), false);
  assert.ok(systemBlock.includes("- chatKey: telegram/demo:1"));
  assert.ok(systemBlock.includes("- task id: cron_demo"));
  assert.ok(systemBlock.includes("- task name: Demo Task"));
  assert.ok(
    systemBlock.includes(
      "- runtime note: header lines above `---` are runtime metadata for this message, not user-authored text.",
    ),
  );
  assert.equal(systemBlock.includes("sender user id:"), false);
  assert.equal(systemBlock.includes("sender nickname:"), false);
  assert.ok(promptText.endsWith("---\nscheduled hello"));
});
