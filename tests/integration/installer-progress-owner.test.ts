import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const progress = await importBuiltModule<
  typeof import("../../src/core/rin-install/progress.js")
>("dist/core/rin-install/progress.js");

async function withStderrTty<T>(isTTY: boolean, run: () => Promise<T> | T) {
  const descriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  Object.defineProperty(process.stderr, "isTTY", {
    configurable: true,
    value: isTTY,
  });
  try {
    return await run();
  } finally {
    if (descriptor) Object.defineProperty(process.stderr, "isTTY", descriptor);
    else delete (process.stderr as any).isTTY;
  }
}

test("installer progress failures preserve specific messages and localize generic steps", () => {
  assert.equal(
    progress.formatInstallerProgressFailureMessage(
      "\u6b63\u5728\u4e0b\u8f7d\u2026\u2026",
      "",
    ),
    "\u4e0b\u8f7d\u5931\u8d25\u3002",
  );
  assert.equal(
    progress.formatInstallerProgressFailureMessage(
      "Downloading...",
      "Install step failed.",
    ),
    "Downloading failed.",
  );
  assert.equal(
    progress.formatInstallerProgressFailureMessage(
      "\u6b63\u5728\u5b89\u88c5\u3002",
      "\u5b89\u88c5\u6b65\u9aa4\u5931\u8d25\u3002",
    ),
    "\u5b89\u88c5\u5931\u8d25\u3002",
  );
  assert.equal(
    progress.formatInstallerProgressFailureMessage(
      "Any step",
      "Exact provider failure",
    ),
    "Exact provider failure",
  );
  assert.equal(
    progress.formatInstallerProgressFailureMessage("   ", ""),
    "   ",
  );
  assert.equal(
    progress.formatInstallerProgressFailureMessage("   ", "fallback"),
    "fallback",
  );
});

test("non-terminal installer progress executes actions without terminal decoration", async () => {
  await withStderrTty(false, async () => {
    let calls = 0;
    const value = await progress.runInstallerProgress("download", async () => {
      calls += 1;
      return 42;
    });
    assert.equal(value, 42);
    assert.equal(calls, 1);
  });
});

test("terminal installer progress returns successful actions after stopping its spinner", async () => {
  await withStderrTty(true, async () => {
    const value = await progress.runInstallerProgress(
      "Downloading",
      () => "done",
      { successMessage: "Downloaded" },
    );
    assert.equal(value, "done");
  });
});

test("terminal installer progress reports failure and rethrows the original error", async () => {
  await withStderrTty(true, async () => {
    const failure = new Error("download failed");
    await assert.rejects(
      () =>
        progress.runInstallerProgress("Downloading...", async () => {
          throw failure;
        }),
      (error) => error === failure,
    );
  });
});

test("cursor restoration tolerates a closed terminal stream", async () => {
  await withStderrTty(true, () => {
    const write = mock.method(process.stderr, "write", () => {
      throw new Error("closed stderr");
    });
    try {
      assert.doesNotThrow(() => progress.restoreTerminalCursor());
    } finally {
      write.mock.restore();
    }
  });
});

test("cursor restoration is a no-op outside terminals", async () => {
  await withStderrTty(false, () => {
    const write = mock.method(process.stderr, "write", () => true);
    try {
      progress.restoreTerminalCursor();
      assert.equal(write.mock.callCount(), 0);
    } finally {
      write.mock.restore();
    }
  });
});
