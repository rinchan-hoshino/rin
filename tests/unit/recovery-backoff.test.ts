import test from "node:test";
import assert from "node:assert/strict";

import { daemonRecoveryDelayMs } from "../../dist/core/rin-daemon/recovery-backoff.js";

test("daemon recovery backoff follows the shared 30-second capped curve", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8].map(daemonRecoveryDelayMs),
    [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000],
  );
  assert.equal(daemonRecoveryDelayMs(0), 500);
  assert.equal(daemonRecoveryDelayMs(Number.NaN), 500);
  assert.equal(daemonRecoveryDelayMs(2.9), 1_000);
});
