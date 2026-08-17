import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { RpcTurnCoordinator } from "../../dist/core/rin-daemon/rpc-turn-coordinator.js";

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test("coordinator keeps one owner through a continuation that starts after settlement", async () => {
  const coordinator = new RpcTurnCoordinator();
  const turn = coordinator.openTurn("owner-tag");
  const admission = coordinator.admit({
    requestTag: "continuation-tag",
    observedRole: "terminalOwner",
  });
  assert.equal(coordinator.isAdmissionPending("continuation-tag"), true);

  turn.observeAgentSettlement();
  const continuationsSettled = turn.waitForContinuations();
  let settled = false;
  void continuationsSettled.then(() => {
    settled = true;
  });

  const match = coordinator.observeUserStart({
    requestTag: "",
    message: { role: "user", content: [{ type: "text", text: "continue" }] },
  });
  assert.equal(match?.admission, admission);
  assert.equal(match?.requestTag, "continuation-tag");
  assert.equal(coordinator.isAdmissionPending("continuation-tag"), false);
  await wait();
  assert.equal(settled, false);

  turn.observeAgentSettlement();
  assert.equal(await continuationsSettled, true);
  assert.equal(coordinator.activeRequestTag, "owner-tag");
  coordinator.closeTurn(turn);
  assert.equal(coordinator.phase, "idle");
});

test("coordinator lease commits exactly one immutable terminal", () => {
  const coordinator = new RpcTurnCoordinator();
  const turn = coordinator.openTurn("owner-tag");
  const commits: string[] = [];
  assert.equal(
    turn.commitTerminal("complete:a", () => commits.push("a")),
    true,
  );
  assert.equal(
    turn.commitTerminal("complete:a", () => commits.push("duplicate")),
    false,
  );
  assert.equal(
    turn.commitTerminal("error:b", () => commits.push("conflict")),
    false,
  );
  assert.deepEqual(commits, ["a"]);
  assert.equal(turn.terminalConflict, true);
  coordinator.closeTurn(turn);
});

test("coordinator assigns untagged user starts by serialized admission order", () => {
  const coordinator = new RpcTurnCoordinator();
  const turn = coordinator.openTurn("owner-tag");
  const firstAdmission = coordinator.admit({
    requestTag: "first-tag",
    observedRole: "terminalOwner",
  });
  const secondAdmission = coordinator.admit({
    requestTag: "second-tag",
    observedRole: "terminalOwner",
  });

  assert.equal(
    coordinator.observeUserStart({
      requestTag: "",
      message: {
        role: "user",
        content: [{ type: "text", text: "runtime-transformed first" }],
      },
    })?.admission,
    firstAdmission,
  );
  assert.equal(
    coordinator.observeUserStart({
      requestTag: "",
      message: { role: "user", content: [{ type: "image" }] },
    })?.admission,
    secondAdmission,
  );
  coordinator.cancelActiveTurn();
  coordinator.closeTurn(turn);
});

test("coordinator permits replacement turns only to the executing interrupt owner", async () => {
  const coordinator = new RpcTurnCoordinator();
  await coordinator.runInterrupt(async (interrupt) => {
    assert.throws(() => coordinator.openTurn("unowned"), /interruption/i);
    const replacement = coordinator.openTurn(
      "replacement",
      undefined,
      interrupt,
    );
    assert.equal(coordinator.activeRequestTag, "replacement");
    coordinator.closeTurn(replacement);
  });
  assert.equal(coordinator.phase, "idle");
});

test("coordinator serializes interrupt operations under one phase owner", async () => {
  const coordinator = new RpcTurnCoordinator();
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = coordinator.runInterrupt(async () => {
    order.push("first:start");
    await firstGate;
    order.push("first:end");
  });
  const second = coordinator.runInterrupt(async () => {
    order.push("second");
  });
  await wait();
  assert.deepEqual(order, ["first:start"]);
  assert.equal(coordinator.phase, "interrupting");

  releaseFirst?.();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second"]);
  assert.equal(coordinator.phase, "idle");
});

test("coordinator invalidation cancels executing and queued interrupt owners", async () => {
  const coordinator = new RpcTurnCoordinator();
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStillCurrent = true;
  let invalidatingRan = false;

  const first = coordinator.runInterrupt(async (interrupt) => {
    await firstGate;
    firstStillCurrent = coordinator.isInterruptCurrent(interrupt);
  });
  await wait();
  const staleQueued = coordinator.runInterrupt(async () => {
    throw new Error("stale queued interrupt must not run");
  });
  const invalidating = coordinator.runInterrupt(
    async () => {
      invalidatingRan = true;
    },
    { invalidate: true },
  );
  const staleQueuedRejected = assert.rejects(staleQueued, /cancelled/i);
  releaseFirst?.();

  await first;
  await staleQueuedRejected;
  await invalidating;
  assert.equal(firstStillCurrent, false);
  assert.equal(invalidatingRan, true);
  assert.equal(coordinator.phase, "idle");
});

test("coordinator interruption closes admissions and cancels every active wait", async () => {
  const coordinator = new RpcTurnCoordinator();
  const turn = coordinator.openTurn("owner-tag");
  coordinator.admit({
    requestTag: "started-tag",
    observedRole: "terminalOwner",
  });
  coordinator.observeUserStart({
    requestTag: "started-tag",
    message: { role: "user", content: [{ type: "text", text: "started" }] },
  });
  coordinator.admit({
    requestTag: "pending-tag",
    observedRole: "terminalOwner",
  });

  const continuationsSettled = turn.waitForContinuations();
  await coordinator.runInterrupt(async () => {
    assert.equal(coordinator.phase, "interrupting");
    assert.throws(
      () =>
        coordinator.admit({
          requestTag: "blocked-tag",
          observedRole: "terminalOwner",
        }),
      /interruption is in progress/i,
    );
    assert.throws(
      () => coordinator.observedRole("pending-tag"),
      /interruption is in progress/i,
    );
    coordinator.cancelActiveTurn();
    assert.equal(await continuationsSettled, true);
    coordinator.closeTurn(turn);
  });
  assert.equal(coordinator.phase, "idle");
});
