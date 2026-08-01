import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const readSource = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

test("Rin projects native Pi lifecycle facts without inventing acceptedAs", () => {
  const rpcMode = readSource("src/core/rin-daemon/rpc-mode.ts");
  const workerPool = readSource("src/core/rin-daemon/worker-pool.ts");
  const rpcCommands = readSource("src/core/rin-lib/rpc.ts");
  const driver = readSource("src/core/rin-frontend-sdk/turn-driver.ts");
  const types = readSource("src/core/rin-frontend-sdk/types.ts");

  assert.doesNotMatch(
    rpcMode,
    /session\.isStreaming\s*\?\s*requestedQueueBehavior/,
  );
  assert.doesNotMatch(rpcMode, /nativeSubmission\.streamingBehavior/);
  assert.doesNotMatch(
    rpcMode,
    /event\.message\.(?:requestTag|rinObservedRole)\s*=/,
  );
  assert.doesNotMatch(rpcMode, /case\s+"steer"\s*:/);
  assert.doesNotMatch(rpcMode, /case\s+"follow_up"\s*:/);
  assert.doesNotMatch(workerPool, /piAdmissionKind/);
  assert.doesNotMatch(workerPool, /\n\s*"(?:steer|follow_up)",/);
  assert.doesNotMatch(rpcCommands, /\n\s*"(?:steer|follow_up)",/);
  assert.doesNotMatch(driver, /acceptedAs|requirePiAdmission/);
  assert.doesNotMatch(types, /acceptedAs\??\s*:/);

  assert.match(rpcMode, /terminalOwner/);
  assert.match(rpcMode, /nonterminal/);
  assert.match(rpcMode, /indeterminate/);
});

test("Chat input routing does not branch on frontend active-turn state", () => {
  const controller = readSource("src/core/chat/controller.ts");
  const runTurn = controller.slice(
    controller.indexOf("async runTurn("),
    controller.indexOf(
      "async interruptTurn(",
      controller.indexOf("async runTurn("),
    ),
  );

  assert.doesNotMatch(runTurn, /hasActiveTurn\(/);
});
