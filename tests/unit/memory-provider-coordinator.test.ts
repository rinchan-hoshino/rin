import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(import.meta.dirname, "../..");
const coordinatorModule = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "memory", "coordinator.js"))
    .href
);
const transcripts = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "memory", "transcripts.js"))
    .href
);

async function withAgentDir(run) {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-memory-coordinator-"),
  );
  try {
    await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

function entry(agentDir, id, text) {
  return {
    id,
    timestamp: "2026-07-29T03:00:00.000Z",
    sessionId: `${id}-session`,
    sessionFile: path.join(agentDir, "sessions", `${id}.jsonl`),
    role: "user",
    text,
    content: [{ type: "text", text }],
  };
}

test("memory coordinator appends native local and extension backends", async () => {
  await withAgentDir(async (agentDir) => {
    const extensionWrites = [];
    const coordinator = coordinatorModule.createMemoryCoordinator({
      agentDir,
      extensions: {
        replaces: () => false,
        recall: async (params) => [
          {
            sourceType: "external",
            provider: "append-extension",
            id: "external-hit",
            name: String(params.query),
            score: 500,
          },
        ],
        write: async (value) => extensionWrites.push(value),
      },
    });

    const value = entry(agentDir, "append-entry", "append coordinator phrase");
    assert.deepEqual(await coordinator.write(value), {
      localIncluded: true,
      operationCount: 2,
      fulfilled: 2,
    });
    assert.equal(extensionWrites[0], value);

    const recalled = await coordinator.recall({
      query: "append coordinator phrase",
      limit: 8,
    });
    assert.equal(recalled.totalResults, 2);
    assert.equal(recalled.results[0]?.provider, "append-extension");
    assert.equal(
      recalled.results.some((result) => result.sourceType === "session"),
      true,
    );
  });
});

test("memory coordinator replacement is capability scoped without making local memory an extension", async () => {
  await withAgentDir(async (agentDir) => {
    await transcripts.appendTranscriptArchiveEntry(
      entry(agentDir, "seed", "native local seed phrase"),
      agentDir,
    );
    const extensionWrites = [];
    const replaced = new Set(["search"]);
    const coordinator = coordinatorModule.createMemoryCoordinator({
      agentDir,
      extensions: {
        replaces: (capability) => replaced.has(capability),
        recall: async () => [
          {
            sourceType: "external",
            provider: "replacement-extension",
            id: "replacement-hit",
            score: 500,
          },
        ],
        write: async (value) => extensionWrites.push(value),
      },
    });

    const search = await coordinator.recall({
      query: "native local seed phrase",
      limit: 8,
    });
    assert.deepEqual(
      search.results.map((result) => result.provider || result.sourceType),
      ["replacement-extension"],
    );

    const recent = await coordinator.recall({ limit: 8 });
    assert.equal(
      recent.results.some((result) => result.sourceType === "session"),
      true,
    );
    assert.equal(
      recent.results.some(
        (result) => result.provider === "replacement-extension",
      ),
      true,
    );

    replaced.add("write");
    const value = entry(agentDir, "replacement", "must stay extension only");
    assert.deepEqual(await coordinator.write(value), {
      localIncluded: false,
      operationCount: 1,
      fulfilled: 1,
    });
    assert.equal(extensionWrites[0], value);
    const sessions = await transcripts.loadRecentTranscriptSessions(
      { limit: 8 },
      agentDir,
    );
    assert.equal(
      sessions.some((result) => result.sessionId === value.sessionId),
      false,
    );
  });
});
