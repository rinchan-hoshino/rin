import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const skillUsage = await importBuiltModule<
  typeof import("../../src/core/self-improve/skill-usage.js")
>("dist/core/self-improve/skill-usage.js");

async function withAgentDir(run: (agentDir: string) => Promise<void>) {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-skill-usage-"));
  try {
    await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

function skillsRoot(agentDir: string) {
  return path.join(agentDir, "self_improve", "skills");
}

test("skill read detection accepts only files inside one named self-improve skill", async () => {
  await withAgentDir(async (agentDir) => {
    const skillPath = path.join(skillsRoot(agentDir), "demo", "SKILL.md");
    assert.deepEqual(
      skillUsage.detectSelfImproveSkillRead({
        agentDir,
        cwd: agentDir,
        args: { path: skillPath },
      }),
      { skillName: "demo", skillPath },
    );
    assert.deepEqual(
      skillUsage.detectSelfImproveSkillRead({
        agentDir,
        cwd: agentDir,
        args: { path: "self_improve/skills/demo/references/guide.md" },
      }),
      {
        skillName: "demo",
        skillPath: path.join(skillPath, "..", "references", "guide.md"),
      },
    );
    assert.equal(
      skillUsage.detectSelfImproveSkillRead({ agentDir, args: null }),
      null,
    );
    assert.equal(
      skillUsage.detectSelfImproveSkillRead({ agentDir, args: [] }),
      null,
    );
    assert.equal(
      skillUsage.detectSelfImproveSkillRead({
        agentDir,
        args: { path: "  " },
      }),
      null,
    );
    assert.equal(
      skillUsage.detectSelfImproveSkillRead({
        agentDir,
        args: { path: skillsRoot(agentDir) },
      }),
      null,
    );
    assert.equal(
      skillUsage.detectSelfImproveSkillRead({
        agentDir,
        args: { path: path.join(agentDir, "self_improve", "prompts", "x.md") },
      }),
      null,
    );
  });
});

test("skill usage stats normalize persisted input and preserve prior optional context", async () => {
  await withAgentDir(async (agentDir) => {
    assert.match(
      skillUsage.skillUsageStatsPath(agentDir),
      /self_improve\/state\/skill-usage\.json$/,
    );
    assert.deepEqual(skillUsage.readSkillUsageStats(agentDir), {
      version: 2,
      startedAt: "",
      updatedAt: "",
      skills: {},
    });

    const statsPath = skillUsage.skillUsageStatsPath(agentDir);
    await fs.mkdir(path.dirname(statsPath), { recursive: true });
    await fs.writeFile(statsPath, "invalid", "utf8");
    assert.deepEqual(skillUsage.readSkillUsageStats(agentDir).skills, {});

    await fs.writeFile(
      statsPath,
      JSON.stringify({
        updatedAt: " 2026-07-16T00:00:00.000Z ",
        skills: {
          "": { name: " " },
          fallback: {
            count: -2,
            firstUsedAt: " first ",
            lastUsedAt: " last ",
            lastSessionId: " ",
          },
          alias: {
            name: " renamed ",
            count: 2.9,
            lastSessionFile: " /tmp/session.jsonl ",
            lastPath: " /tmp/SKILL.md ",
          },
        },
      }),
      "utf8",
    );
    const normalized = skillUsage.readSkillUsageStats(agentDir);
    assert.equal(normalized.updatedAt, "2026-07-16T00:00:00.000Z");
    assert.deepEqual(normalized.skills.fallback, {
      name: "fallback",
      count: 0,
      firstUsedAt: "first",
      lastUsedAt: "last",
      lastSessionId: undefined,
      lastSessionFile: undefined,
      lastPath: undefined,
    });
    assert.deepEqual(normalized.skills.renamed, {
      name: "renamed",
      count: 2,
      firstUsedAt: "",
      lastUsedAt: "",
      lastSessionId: undefined,
      lastSessionFile: "/tmp/session.jsonl",
      lastPath: "/tmp/SKILL.md",
    });
    assert.equal(normalized.version, 2);
    assert.equal(normalized.startedAt, "first");
  });
});

test("skill usage event ledger snapshots legacy aggregates and rebuilds around malformed entries", async () => {
  await withAgentDir(async (agentDir) => {
    const statsPath = skillUsage.skillUsageStatsPath(agentDir);
    const eventsPath = skillUsage.skillUsageEventsPath(agentDir);
    await fs.mkdir(path.dirname(statsPath), { recursive: true });
    await fs.writeFile(
      statsPath,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-07-16T00:01:00.000Z",
        skills: {
          legacy: {
            name: "legacy",
            count: 2,
            firstUsedAt: "2026-07-16T00:00:00.000Z",
            lastUsedAt: "2026-07-16T00:01:00.000Z",
            lastSessionId: "session-old",
          },
        },
      }),
      "utf8",
    );

    await skillUsage.recordSelfImproveSkillUsage({
      agentDir,
      skillName: "legacy",
      skillPath: "/skills/legacy/SKILL.md",
      sessionId: "session-new",
      timestamp: "2026-07-16T00:02:00.000Z",
    });

    const recordedLines = (await fs.readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(recordedLines.length, 2);
    assert.equal(recordedLines[0].kind, "snapshot");
    assert.equal(recordedLines[1].kind, "read");

    await fs.rm(statsPath);
    await fs.appendFile(
      eventsPath,
      [
        "not-json",
        JSON.stringify({ timestamp: "", name: "ignored" }),
        JSON.stringify({
          timestamp: "2026-07-16T00:03:00.000Z",
          name: "legacy",
          sessionFile: " /tmp/new.jsonl ",
          path: " ",
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const rebuilt = skillUsage.readSkillUsageStats(agentDir);
    assert.equal(rebuilt.version, 2);
    assert.equal(rebuilt.startedAt, "2026-07-16T00:00:00.000Z");
    assert.equal(rebuilt.updatedAt, "2026-07-16T00:03:00.000Z");
    assert.deepEqual(rebuilt.skills.legacy, {
      name: "legacy",
      count: 4,
      firstUsedAt: "2026-07-16T00:00:00.000Z",
      lastUsedAt: "2026-07-16T00:03:00.000Z",
      lastSessionId: "session-new",
      lastSessionFile: "/tmp/new.jsonl",
      lastPath: "/skills/legacy/SKILL.md",
    });
  });
});

test("recording usage creates, increments, and selectively updates skill context", async () => {
  await withAgentDir(async (agentDir) => {
    await skillUsage.recordSelfImproveSkillUsage({
      agentDir: " ",
      skillName: "demo",
    });
    await skillUsage.recordSelfImproveSkillUsage({
      agentDir,
      skillName: " ",
    });
    assert.deepEqual(skillUsage.readSkillUsageStats(agentDir).skills, {});

    await skillUsage.recordSelfImproveSkillUsage({
      agentDir,
      skillName: " demo ",
      skillPath: " /skills/demo/SKILL.md ",
      sessionId: " session-1 ",
      sessionFile: " /tmp/one.jsonl ",
      timestamp: "2026-07-16T00:00:00.000Z",
    });
    await skillUsage.recordSelfImproveSkillUsage({
      agentDir,
      skillName: "demo",
      sessionId: "session-2",
      timestamp: "2026-07-16T00:01:00.000Z",
    });
    const demo = skillUsage.readSkillUsageStats(agentDir).skills.demo;
    assert.deepEqual(demo, {
      name: "demo",
      count: 2,
      firstUsedAt: "2026-07-16T00:00:00.000Z",
      lastUsedAt: "2026-07-16T00:01:00.000Z",
      lastSessionId: "session-2",
      lastSessionFile: "/tmp/one.jsonl",
      lastPath: "/skills/demo/SKILL.md",
    });

    await skillUsage.recordSelfImproveSkillUsage({
      agentDir,
      skillName: "clocked",
    });
    assert.match(
      skillUsage.readSkillUsageStats(agentDir).skills.clocked.lastUsedAt,
      /^\d{4}-\d{2}-\d{2}T/,
    );
  });
});

test("read events record session metadata only for matching read tools", async () => {
  await withAgentDir(async (agentDir) => {
    const skillPath = path.join(skillsRoot(agentDir), "active", "SKILL.md");
    await skillUsage.recordSelfImproveSkillReadEvent(
      { toolName: "write", args: { path: skillPath } },
      { agentDir },
    );
    await skillUsage.recordSelfImproveSkillReadEvent(
      { toolName: "read", args: { path: skillPath } },
      { agentDir: " " },
    );
    await skillUsage.recordSelfImproveSkillReadEvent(
      { toolName: "read", args: { path: "/tmp/outside.md" } },
      { agentDir },
    );
    assert.deepEqual(skillUsage.readSkillUsageStats(agentDir).skills, {});

    await skillUsage.recordSelfImproveSkillReadEvent(
      { toolName: " read ", args: { path: skillPath } },
      {
        agentDir,
        cwd: agentDir,
        sessionId: "session-3",
        sessionFile: "/tmp/three.jsonl",
      },
    );
    const active = skillUsage.readSkillUsageStats(agentDir).skills.active;
    assert.equal(active.count, 1);
    assert.equal(active.lastSessionId, "session-3");
    assert.equal(active.lastSessionFile, "/tmp/three.jsonl");
    assert.equal(active.lastPath, skillPath);
  });
});
