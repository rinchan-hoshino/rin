import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const commandResponses = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat", "command-responses.js"),
  ).href
);
const rinI18n = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "i18n.js")).href
);

test("chat command responses default to English when local i18n file is absent", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-command-copy-"),
  );

  assert.equal(
    commandResponses.readChatCommandResponses(agentDir).new,
    "Started a new session.",
  );
});

test("chat command responses can be overridden from the generic i18n catalog", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-command-copy-"),
  );
  const customNew = String.fromCharCode(
    0x5df2,
    0x5f00,
    0x59cb,
    0x65b0,
    0x4f1a,
    0x8bdd,
    0x3002,
  );
  await fs.writeFile(
    rinI18n.rinI18nPath(agentDir),
    JSON.stringify({ "chat.commandResponses.new": customNew }),
  );

  const responses = commandResponses.readChatCommandResponses(agentDir);
  assert.equal(responses.new, customNew);
  assert.equal(responses.abort, "Aborted current operation.");
});

test("generic i18n catalog accepts nested message keys", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-command-copy-"),
  );
  await fs.writeFile(
    rinI18n.rinI18nPath(agentDir),
    JSON.stringify({
      chat: {
        commandResponses: {
          reload: "Reloaded from i18n catalog.",
        },
      },
    }),
  );

  const responses = commandResponses.readChatCommandResponses(agentDir);
  assert.equal(responses.reload, "Reloaded from i18n catalog.");
  assert.equal(responses.new, "Started a new session.");
});

test("chat i18n exposes dynamic compact and self-improve review templates", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-command-copy-"),
  );
  await fs.writeFile(
    rinI18n.rinI18nPath(agentDir),
    JSON.stringify({
      chat: {
        compaction: {
          busy: "Already compacting.",
          summaryLine: "Shrunk {tokens}; open with {expandKey}.",
          summaryText: "COMPACT: {summary}",
        },
        selfImproveReview: {
          changedWithMore: "Reviewed {targets} plus {count} hidden.",
        },
      },
    }),
  );

  const responses = commandResponses.readChatCommandResponses(agentDir);
  assert.equal(responses.compactionBusy, "Already compacting.");
  assert.equal(
    responses.compactionSummaryLine,
    "Shrunk {tokens}; open with {expandKey}.",
  );
  assert.equal(responses.compactionSummaryText, "COMPACT: {summary}");
  assert.equal(
    responses.selfImproveReviewChangedWithMore,
    "Reviewed {targets} plus {count} hidden.",
  );
});
