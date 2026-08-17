import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const interruption = await importBuiltModule<Record<string, any>>(
  "dist/core/rin-lib/interruption.js",
);

test("daemon interruption payload and tool message preserve one terminal reason", () => {
  assert.deepEqual(interruption.createInterruptedToolResultPayload(), {
    content: [{ type: "text", text: interruption.INTERRUPTED_TOOL_TEXT }],
    details: { interrupted: true, reason: interruption.DAEMON_EXIT_REASON },
  });
  const before = Date.now();
  const message = interruption.createInterruptedToolResultMessage({
    id: 42,
    name: null,
  });
  const after = Date.now();
  assert.deepEqual(
    { ...message, timestamp: 0 },
    {
      role: "toolResult",
      toolCallId: "42",
      toolName: "",
      content: [{ type: "text", text: interruption.INTERRUPTED_TOOL_TEXT }],
      details: { interrupted: true, reason: interruption.DAEMON_EXIT_REASON },
      isError: true,
      timestamp: 0,
    },
  );
  assert.ok(message.timestamp >= before && message.timestamp <= after);
  assert.equal(
    interruption.createInterruptedToolResultMessage(undefined).toolCallId,
    "",
  );
});
