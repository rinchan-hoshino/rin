import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const memoryIndex = await importBuiltModule<
  typeof import("../../src/core/rin/memory-index.js")
>("dist/core/rin/memory-index.js");

function parsed(installDir: string) {
  return {
    command: "memory-index",
    targetUser: os.userInfo().username,
    targetName: "",
    installDir,
    passthrough: [],
    explicitUser: true,
    explicitTarget: false,
    hasSavedInstall: true,
    releaseChannel: "stable",
    releaseBranch: "",
    releaseVersion: "",
    explicitReleaseChannel: false,
    updateAssumeYes: false,
  } as any;
}

async function withAgentDir(run: (agentDir: string) => Promise<void>) {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-memory-index-owner-"),
  );
  try {
    await fs.mkdir(path.join(agentDir, "memory", "transcripts", "2026", "07"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(
        agentDir,
        "memory",
        "transcripts",
        "2026",
        "07",
        "sample.jsonl",
      ),
      [
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "hello" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: "world" },
        }),
      ].join("\n") + "\n",
    );
    await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

test("memory-index parser recognizes wrapper placement and help aliases", () => {
  assert.deepEqual(memoryIndex.parseMemoryIndexArgs(["memory-index"]), {
    action: "repair",
    help: false,
  });
  assert.deepEqual(
    memoryIndex.parseMemoryIndexArgs([
      "-u",
      "rin",
      "memory-index",
      "repair",
      "-h",
    ]),
    { action: "repair", help: true },
  );
  assert.deepEqual(
    memoryIndex.parseMemoryIndexArgs(["--user=rin", "memory-index", "--help"]),
    { action: "repair", help: true },
  );
});

test("memory-index help is handled before loading transcript storage", async () => {
  const lines: string[] = [];
  const log = mock.method(console, "log", (...args) =>
    lines.push(args.join(" ")),
  );
  try {
    await memoryIndex.runMemoryIndexInternal(["memory-index", "--help"]);
    await memoryIndex.runMemoryIndex(parsed("/not-used"), [
      "memory-index",
      "-h",
    ]);
  } finally {
    log.mock.restore();
  }
  assert.equal(lines.length, 2);
  assert.match(lines[0], /rin memory-index repair/);
  assert.match(lines[1], /rebuild the recall index/);
});

test("memory-index repairs the selected local target and reports persisted counts", async () => {
  await withAgentDir(async (agentDir) => {
    const lines: string[] = [];
    const log = mock.method(console, "log", (...args) =>
      lines.push(args.join(" ")),
    );
    try {
      await memoryIndex.runMemoryIndex(parsed(agentDir), [
        "memory-index",
        "repair",
      ]);
    } finally {
      log.mock.restore();
    }

    assert.equal(lines.length, 1);
    assert.match(lines[0], /^memory index repaired\n/);
    assert.match(
      lines[0],
      new RegExp(
        `transcriptRoot=${agentDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
    );
    assert.match(lines[0], /fileCount=1/);
    assert.match(lines[0], /entryCount=/);
  });
});

test("memory-index internal repair honors RIN_DIR over HOME", async () => {
  await withAgentDir(async (agentDir) => {
    const previous = process.env.RIN_DIR;
    const lines: string[] = [];
    const log = mock.method(console, "log", (...args) =>
      lines.push(args.join(" ")),
    );
    process.env.RIN_DIR = `  ${agentDir}  `;
    try {
      await memoryIndex.runMemoryIndexInternal(["memory-index", "repair"]);
    } finally {
      log.mock.restore();
      if (previous === undefined) delete process.env.RIN_DIR;
      else process.env.RIN_DIR = previous;
    }
    assert.match(lines[0], /memory index repaired/);
    assert.match(lines[0], /fileCount=1/);
  });
});

test("memory-index forwards cross-user repair through the internal command", async () => {
  const captures: any[][] = [];
  const exec = mock.method(childProcess, "execFileSync", (...args: any[]) => {
    captures.push(args);
    return "forwarded repair\n";
  });
  const writes: string[] = [];
  const write = mock.method(process.stdout, "write", (value: any) => {
    writes.push(String(value));
    return true;
  });
  syncBuiltinESMExports();
  try {
    await memoryIndex.runMemoryIndex(
      { ...parsed("/srv/rin"), targetUser: "nobody" },
      ["--user", "nobody", "memory-index", "repair"],
    );
  } finally {
    exec.mock.restore();
    syncBuiltinESMExports();
    write.mock.restore();
  }

  assert.ok(captures.length >= 1);
  assert.match(JSON.stringify(captures), /__memory_index_internal/);
  assert.deepEqual(writes, ["forwarded repair\n"]);
});
