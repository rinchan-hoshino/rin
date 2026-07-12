import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const childSignals = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "platform", "child-signals.js"),
  ).href
);

test("child signal forwarding relays supported signals and cleans listeners", () => {
  const emitter = new EventEmitter();
  const killed = [];
  const before = [];
  const child = {
    killed: false,
    kill(signal) {
      killed.push(signal);
      return true;
    },
  };
  const forwarding = childSignals.forwardChildSignals(child, {
    emitter,
    beforeForward: (signal) => before.push(signal),
  });

  emitter.emit("SIGTERM");
  assert.equal(forwarding.forwardedSignal, "SIGTERM");
  assert.deepEqual(before, ["SIGTERM"]);
  assert.deepEqual(killed, ["SIGTERM"]);

  forwarding.cleanup();
  emitter.emit("SIGINT");
  assert.deepEqual(killed, ["SIGTERM"]);
});

test("child signal exit codes use POSIX conventions", () => {
  assert.equal(childSignals.signalExitCode("SIGHUP"), 129);
  assert.equal(childSignals.signalExitCode("SIGINT"), 130);
  assert.equal(childSignals.signalExitCode("SIGTERM"), 143);
  assert.equal(childSignals.signalExitCode("SIGUSR1"), 1);
});
