import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const providerContext = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-lib", "provider-context.js"),
  ).href
);

test("provider-bound context policy omits old tool results for model-bound contexts", () => {
  const messages = [
    { role: "user", content: "turn 1" },
    { role: "toolResult", content: "huge old output" },
    { role: "assistant", content: "done 1" },
    { role: "user", content: "turn 2" },
    { role: "assistant", content: "done 2" },
    { role: "user", content: "turn 3" },
    { role: "assistant", content: "done 3" },
    { role: "user", content: "turn 4" },
    { role: "assistant", content: "done 4" },
    { role: "user", content: "turn 5" },
    { role: "assistant", content: "done 5" },
  ];

  const providerMessages =
    providerContext.buildProviderBoundContextMessages(messages);

  assert.notEqual(providerMessages, messages);
  assert.equal(
    providerMessages[1].content,
    "[old tool result omitted to save context.]",
  );
  assert.equal(messages[1].content, "huge old output");
});

test("provider-bound context policy maps compaction slices through the full context view", () => {
  const oldToolResult = { role: "toolResult", content: "huge old output" };
  const summarizedSlice = [
    { role: "user", content: "turn 1" },
    oldToolResult,
    { role: "assistant", content: "done 1" },
  ];
  const fullContext = [
    summarizedSlice[0],
    oldToolResult,
    summarizedSlice[2],
    { role: "user", content: "turn 2" },
    { role: "assistant", content: "done 2" },
    { role: "user", content: "turn 3" },
    { role: "assistant", content: "done 3" },
    { role: "user", content: "turn 4" },
    { role: "assistant", content: "done 4" },
    { role: "user", content: "turn 5" },
    { role: "assistant", content: "done 5" },
  ];

  const mapped = providerContext.mapMessagesToProviderBoundContext(
    summarizedSlice,
    fullContext,
  );

  assert.notEqual(mapped, summarizedSlice);
  assert.equal(mapped[1].content, "[old tool result omitted to save context.]");
  assert.equal(oldToolResult.content, "huge old output");
});

test("provider-bound context policy owns token estimates", () => {
  const messages = [
    { role: "user", content: "turn 1" },
    { role: "toolResult", content: "huge old output" },
    { role: "assistant", content: "done 1" },
    { role: "user", content: "turn 2" },
    { role: "assistant", content: "done 2" },
    { role: "user", content: "turn 3" },
    { role: "assistant", content: "done 3" },
    { role: "user", content: "turn 4" },
    { role: "assistant", content: "done 4" },
    { role: "user", content: "turn 5" },
    { role: "assistant", content: "done 5" },
  ];

  const tokens = providerContext.estimateProviderBoundContextTokens(
    messages,
    (nextMessages: any[]) => ({
      tokens: nextMessages.some(
        (message) => message.content === "huge old output",
      )
        ? 900
        : 10,
    }),
  );

  assert.equal(tokens, 10);
});

test("provider-bound context event uses the same policy surface", () => {
  const messages = [
    { role: "user", content: "turn 1" },
    { role: "toolResult", content: "huge old output" },
    { role: "assistant", content: "done 1" },
    { role: "user", content: "turn 2" },
    { role: "assistant", content: "done 2" },
    { role: "user", content: "turn 3" },
    { role: "assistant", content: "done 3" },
    { role: "user", content: "turn 4" },
    { role: "assistant", content: "done 4" },
    { role: "user", content: "turn 5" },
    { role: "assistant", content: "done 5" },
  ];

  const result = providerContext.buildProviderBoundContextEvent({ messages });

  assert.equal(
    result.messages[1].content,
    "[old tool result omitted to save context.]",
  );
});
