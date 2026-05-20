import test from "node:test";
import assert from "node:assert/strict";

import heartbeatCapability from "../../src/core/heartbeat/index.ts";

test("heartbeat capability exposes only the inbox read marker tool", () => {
  assert.deepEqual(
    (heartbeatCapability({} as any).tools || []).map((tool) => tool.name),
    ["mark_heartbeat_info_read"],
  );
});
