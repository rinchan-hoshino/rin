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

test("scheduled chat-bound prompt context keeps chat and task metadata in the system prompt", () => {
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

  assert.equal(promptText.includes("chatKey: telegram/demo:1"), false);
  assert.equal(promptText.includes("chat trigger:"), false);
  assert.equal(promptText.includes("task id: cron_demo"), false);
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
