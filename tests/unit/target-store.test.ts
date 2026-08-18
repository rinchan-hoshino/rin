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

test("target store ignores retired defaults, filters nameless rows, and sorts copies", () => {
  withStore((filePath) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        defaultTarget: " Demo Box ",
        targets: [
          { name: "zeta", marker: 1, default: true },
          { name: "", marker: 2 },
          { marker: 3 },
          { name: "Alpha", marker: 4 },
        ],
      }),
      "utf8",
    );

    assert.deepEqual(store.readTargetStore(filePath), {
      targets: [
        { name: "zeta", marker: 1 },
        { name: "Alpha", marker: 4 },
      ],
    });
    store.writeTargetStore(store.readTargetStore(filePath), filePath);
    assert.equal(
      "defaultTarget" in JSON.parse(fs.readFileSync(filePath, "utf8")),
      false,
    );
    assert.deepEqual(
      store.listTargets(filePath).map((target) => target.name),
      ["Alpha", "zeta"],
    );
    assert.equal(store.findTarget(" alpha ", filePath)?.marker, 4);
    assert.equal(store.findTarget("   ", filePath), undefined);
  });
});

test("target store upserts, preserves creation time, and removes targets", () => {
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
    assert.equal(
      updated.runtime.kind === "ssh" && updated.runtime.host,
      "new-host",
    );
    assert.equal(store.removeTarget("missing", filePath), false);
    assert.equal(store.removeTarget(" DEMO BOX ", filePath), true);
    assert.equal(store.removeTarget("demo-box", filePath), false);
  });
});

test("target store validates names", () => {
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
  });
});
