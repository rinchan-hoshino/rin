import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const managedService = await importBuiltModule<
  typeof import("../../src/core/rin-install/managed-service.js")
>("dist/core/rin-install/managed-service.js");

test("status snapshots prefer successful, richer output and preserve useful command errors", () => {
  const units = [
    "missing.service",
    "short.service",
    "rich.service",
    "blank.service",
  ];
  const snapshot = managedService.findManagedSystemdStatusSnapshot(
    units,
    (unit) => {
      if (unit === "missing.service") {
        throw { stdout: "", stderr: "missing stderr\nsecond error" };
      }
      if (unit === "short.service") return "active";
      if (unit === "rich.service") return "active\nloaded\nready";
      return " \n";
    },
    2,
  );
  assert.deepEqual(snapshot, {
    unit: "rich.service",
    lines: ["active", "loaded"],
  });

  assert.deepEqual(
    managedService.findManagedSystemdStatusSnapshot(
      ["stdout.service", "message.service"],
      (unit) => {
        if (unit === "stdout.service") {
          throw { stdout: "stdout detail", stderr: "ignored stderr" };
        }
        throw new Error("message detail");
      },
    ),
    { unit: "stdout.service", lines: ["stdout detail"] },
  );
  assert.equal(
    managedService.findManagedSystemdStatusSnapshot(["blank.service"], () => {
      throw { stdout: " ", stderr: " ", message: " " };
    }),
    null,
  );
});

test("journal snapshots keep the newest lines and first equally rich unit", () => {
  const snapshot = managedService.findManagedSystemdJournalSnapshot(
    ["failed.service", "first.service", "second.service"],
    (unit) => {
      if (unit === "failed.service") throw new Error("journal unavailable");
      if (unit === "first.service") return "old\nrecent one\nrecent two";
      return "older\nsecond one\nsecond two";
    },
    2,
  );
  assert.deepEqual(snapshot, {
    unit: "first.service",
    lines: ["recent one", "recent two"],
  });
  assert.equal(
    managedService.findManagedSystemdJournalSnapshot(
      ["empty.service"],
      () => "\r\n  \r\n",
    ),
    null,
  );
});

test("managed actions ignore reload failures and try units in order", () => {
  const calls: string[] = [];
  assert.equal(
    managedService.tryManagedSystemdAction(["bad", "good"], {
      daemonReload: () => {
        calls.push("reload");
        throw new Error("reload failed");
      },
      probeUnit: (unit) => {
        calls.push(`probe:${unit}`);
        if (unit === "bad") throw new Error("not installed");
      },
      runAction: (unit) => calls.push(`run:${unit}`),
    }),
    "good",
  );
  assert.deepEqual(calls, ["reload", "probe:bad", "probe:good", "run:good"]);

  assert.equal(
    managedService.tryManagedSystemdAction(["one", "two"], {
      runAction: () => {
        throw new Error("cannot act");
      },
    }),
    null,
  );
  assert.equal(
    managedService.tryManagedSystemdAction(["direct"], {
      runAction: () => undefined,
    }),
    "direct",
  );
});
