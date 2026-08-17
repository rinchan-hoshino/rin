import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const store = await importBuiltModule<
  typeof import("../../src/core/rin-targets/store.js")
>("dist/core/rin-targets/store.js");

function withStore(run: (filePath: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-target-store-"));
  try {
    run(path.join(dir, "nested", "targets.json"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("target store paths and malformed files resolve to an empty store", () => {
  assert.equal(
    store.targetStorePath("/tmp/demo-home"),
    path.join("/tmp/demo-home", ".rin", "targets.json"),
  );
  withStore((filePath) => {
    assert.deepEqual(store.readTargetStore(filePath), { targets: [] });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "not-json", "utf8");
    assert.deepEqual(store.readTargetStore(filePath), { targets: [] });
  });
});

test("target store normalizes persisted defaults, filters nameless rows, and sorts copies", () => {
  withStore((filePath) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        defaultTarget: " Demo Box ",
        targets: [
          { name: "zeta", marker: 1 },
          { name: "", marker: 2 },
          { marker: 3 },
          { name: "Alpha", marker: 4 },
        ],
      }),
      "utf8",
    );

    assert.deepEqual(store.readTargetStore(filePath), {
      defaultTarget: "demo-box",
      targets: [
        { name: "zeta", marker: 1 },
        { name: "Alpha", marker: 4 },
      ],
    });
    assert.deepEqual(
      store.listTargets(filePath).map((target) => target.name),
      ["Alpha", "zeta"],
    );
    assert.equal(store.findTarget(" alpha ", filePath)?.marker, 4);
    assert.equal(store.findTarget("   ", filePath), undefined);
    assert.equal(store.getDefaultTarget(filePath), undefined);
  });
});

test("target store upserts, preserves creation time, defaults, and removes targets", () => {
  withStore((filePath) => {
    const first = store.upsertTarget(
      {
        name: "Demo Box",
        kind: "ssh",
        runtime: { kind: "ssh", host: "demo" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      filePath,
    );
    assert.equal(first.name, "demo-box");
    assert.equal(first.createdAt, "2026-01-01T00:00:00.000Z");
    assert.equal(store.getDefaultTarget(filePath)?.name, "demo-box");

    const updated = store.upsertTarget(
      {
        name: " DEMO BOX ",
        kind: "ssh",
        runtime: { kind: "ssh", host: "new-host" },
        updatedAt: "2026-02-02T00:00:00.000Z",
      },
      filePath,
    );
    assert.equal(updated.createdAt, first.createdAt);
    assert.equal(updated.updatedAt, "2026-02-02T00:00:00.000Z");
    assert.equal(updated.runtime.kind, "ssh");
    assert.equal(
      updated.runtime.kind === "ssh" && updated.runtime.host,
      "new-host",
    );

    store.upsertTarget(
      {
        name: "local",
        kind: "local-user",
        runtime: { kind: "local-user", user: "rin" },
        default: true,
      },
      filePath,
    );
    assert.deepEqual(
      store.listTargets(filePath).map((target) => target.name),
      ["demo-box", "local"],
    );
    assert.equal(store.getDefaultTarget(filePath)?.name, "local");
    assert.equal(store.removeTarget("missing", filePath), false);
    assert.equal(store.removeTarget(" LOCAL ", filePath), true);
    assert.equal(store.getDefaultTarget(filePath), undefined);
    assert.equal(store.removeTarget("local", filePath), false);
  });
});

test("target store validates names and explicit default selection", () => {
  withStore((filePath) => {
    assert.throws(
      () =>
        store.upsertTarget(
          {
            name: " !!! ",
            kind: "ssh",
            runtime: { kind: "ssh", host: "invalid" },
          },
          filePath,
        ),
      /rin_target_name_required/,
    );

    store.upsertTarget(
      {
        name: "one",
        kind: "ssh",
        runtime: { kind: "ssh", host: "one" },
      },
      filePath,
    );
    store.upsertTarget(
      {
        name: "two",
        kind: "ssh",
        runtime: { kind: "ssh", host: "two" },
      },
      filePath,
    );
    assert.throws(
      () => store.setDefaultTarget("missing", filePath),
      /rin_target_not_found:missing/,
    );

    store.setDefaultTarget(" TWO ", filePath);
    assert.equal(store.getDefaultTarget(filePath)?.name, "two");
    assert.deepEqual(
      store
        .listTargets(filePath)
        .map((target) => [target.name, target.default]),
      [
        ["one", undefined],
        ["two", true],
      ],
    );
  });
});
