import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

await import("../support/register-self-improve-cli-owner-fixture.ts");
const selfImprove = await import(
  pathToFileURL(path.resolve("dist/core/rin/self-improve.js")).href
);
const ownerGlobal = globalThis as any;
const events = ownerGlobal.__rinSelfImproveEvents as any[];

function options(overrides: Record<string, any> = {}) {
  return {
    limit: 20,
    explicitLimit: false,
    once: false,
    watch: true,
    intervalMs: 2000,
    json: false,
    help: false,
    ...overrides,
  };
}

function withHistory(
  records: Record<string, any>[],
  run: (agentDir: string) => void | Promise<void>,
) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-self-owner-"));
  fs.writeFileSync(
    path.join(agentDir, "maintenance-history.jsonl"),
    ["not-json", ...records.map((record) => JSON.stringify(record)), ""].join(
      "\n",
    ),
  );
  return Promise.resolve(run(agentDir)).finally(() =>
    fs.rmSync(agentDir, { recursive: true, force: true }),
  );
}

function record(overrides: Record<string, any> = {}) {
  return {
    id: "run-owner",
    status: "completed",
    trigger: "owner:daily",
    sessionFile: "/sessions/managed/owner.jsonl",
    startedAt: "2026-07-16T10:00:00.000Z",
    finishedAt: "2026-07-16T10:01:00.000Z",
    attempts: 2,
    changedFiles: [
      { path: "self_improve/prompts/profile.md", change: "updated" },
    ],
    outputPreview: "owner preview",
    ...overrides,
  };
}

async function captureConsole(run: () => unknown | Promise<unknown>) {
  const output: string[] = [];
  const original = console.log;
  console.log = (...values: any[]) => output.push(values.join(" "));
  try {
    await run();
  } finally {
    console.log = original;
  }
  return output;
}

async function captureStdout(run: () => unknown | Promise<unknown>) {
  const output: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((value: string | Uint8Array) => {
    output.push(String(value));
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = original;
  }
  return output.join("");
}

test("self-improve parser owns every option, wrapper boundary, and validation error", () => {
  const parsed = selfImprove.parseSelfImproveArgs([
    "--user=owner",
    "self-improve",
    "--watch",
    "--once",
    "--watch",
    "--json",
    "--id",
    "run-owner",
    "--from",
    "2h",
    "--to",
    "2026-07-17",
    "--limit",
    "3.6",
    "--status",
    "failed",
    "--trigger",
    "owner",
    "--interval=0.01",
    "--help",
  ]);
  assert.equal(parsed.id, "run-owner");
  assert.match(parsed.from, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(parsed.to, "2026-07-17T23:59:59.999Z");
  assert.equal(parsed.limit, 4);
  assert.equal(parsed.explicitLimit, true);
  assert.equal(parsed.status, "failed");
  assert.equal(parsed.trigger, "owner");
  assert.equal(parsed.intervalMs, 100);
  assert.equal(parsed.help, true);
  assert.equal(parsed.once, true);
  assert.equal(parsed.watch, false);

  assert.equal(
    selfImprove.parseSelfImproveArgs(["self-improve", "--from", "30m"]).from
      .length > 0,
    true,
  );
  assert.equal(
    selfImprove.parseSelfImproveArgs(["self-improve", "--from", "2d"]).from
      .length > 0,
    true,
  );
  assert.equal(
    selfImprove.parseSelfImproveArgs(["self-improve", "--from", "1w"]).from
      .length > 0,
    true,
  );
  assert.equal(
    selfImprove.parseSelfImproveArgs(["self-improve", "--from", "2026-07-17"])
      .from,
    "2026-07-17T00:00:00.000Z",
  );
  assert.equal(
    selfImprove.parseSelfImproveArgs([
      "self-improve",
      "--from",
      "2026-07-17T03:00:00+03:00",
    ]).from,
    "2026-07-17T00:00:00.000Z",
  );
  assert.equal(
    selfImprove.parseSelfImproveArgs(["self-improve", "--limit", "bad"]).limit,
    20,
  );
  assert.equal(
    selfImprove.parseSelfImproveArgs(["self-improve", "--interval", "2"])
      .intervalMs,
    2000,
  );
  assert.throws(
    () => selfImprove.parseSelfImproveArgs(["self-improve", "--interval"]),
    /missing_self_improve_interval/,
  );
  assert.throws(
    () =>
      selfImprove.parseSelfImproveArgs(["self-improve", "--interval", "soon"]),
    /invalid_self_improve_interval:soon/,
  );
  assert.throws(
    () => selfImprove.parseSelfImproveArgs(["self-improve", "--from", "later"]),
    /invalid_time:later/,
  );
  assert.throws(
    () => selfImprove.parseSelfImproveArgs(["self-improve", "--owner-only"]),
    /unknown_self_improve_arg:--owner-only/,
  );
});

test("self-improve reports preserve filtering, detail, backend, table, and TUI contracts", async () => {
  await withHistory(
    [
      record(),
      record({
        id: "run-failed",
        status: "failed",
        trigger: "owner:manual",
        finishedAt: "2026-07-17T11:00:00.000Z",
        attempts: 0,
        error: "owner failure",
        changedFiles: [
          { path: "a.md", change: "created" },
          { path: "b.md" },
          { path: "c.md", change: "deleted" },
          { path: "d.md", change: "updated" },
          { path: "e.md", change: "updated" },
        ],
      }),
      record({
        id: "run-skipped",
        status: "skipped",
        trigger: "other",
        finishedAt: "invalid",
        sessionFile: "",
        skipped: "unchanged",
        changedFiles: [{ change: "updated" }],
      }),
      { id: "run-unknown", startedAt: "2026-07-15T00:00:00.000Z" },
    ],
    (agentDir) => {
      const once = selfImprove.renderSelfImproveReport(
        agentDir,
        options({
          once: true,
          watch: false,
          from: "2026-07-16T00:00:00.000Z",
          to: "2026-07-18T00:00:00.000Z",
          limit: 10,
        }),
      );
      assert.match(once, /Rin self-improve history/);
      assert.match(once, /owner failure/);
      assert.match(
        once,
        /created:a\.md, updated:b\.md, deleted:c\.md, updated:d\.md \+1/,
      );

      const filtered = JSON.parse(
        selfImprove.renderSelfImproveReport(
          agentDir,
          options({
            json: true,
            once: true,
            watch: false,
            status: "completed",
            trigger: "daily",
            from: "2026-07-16T00:00:00.000Z",
            to: "2026-07-16T23:59:59.999Z",
            limit: 1,
            explicitLimit: true,
          }),
        ),
      );
      assert.deepEqual(filtered.stats, {
        totalRuns: 1,
        completed: 1,
        failed: 0,
        changedFiles: 1,
        first: "2026-07-16T10:01:00.000Z",
        last: "2026-07-16T10:01:00.000Z",
      });
      assert.equal(filtered.records.length, 1);
      assert.equal(filtered.generatedAt, "2026-07-17T12:34:56.000Z");
      assert.equal(filtered.filters.limit, 1);

      const detail = selfImprove.renderSelfImproveReport(
        agentDir,
        options({ id: "run-owner", once: true, watch: false }),
      );
      assert.match(detail, /Rin self-improve detail: run-owner/);
      assert.match(detail, /output preview:\nowner preview/);
      assert.match(
        selfImprove.renderSelfImproveReport(
          agentDir,
          options({ id: "missing", once: true, watch: false }),
        ),
        /not found/,
      );

      const tui = selfImprove.renderSelfImproveTui(
        agentDir,
        options({ from: "2026-07-15T00:00:00.000Z" }),
        { selectedIndex: 999, expanded: false },
        { width: 70, height: 16, interactive: true },
      );
      assert.match(tui, /Self-Improve Runs/);
      assert.match(tui, /↑\/↓ j\/k move/);
      assert.match(tui, /Details/);
      assert.equal(
        tui.split("\n").every((line: string) => line.length <= 70),
        true,
      );

      const expanded = selfImprove.renderSelfImproveTui(
        agentDir,
        options({ from: "2026-07-15T00:00:00.000Z" }),
        { selectedIndex: 1, expanded: true },
        { width: 180, height: 30, interactive: false },
      );
      assert.match(expanded, /snapshot view/);
      assert.match(expanded, /Rin self-improve detail/);
    },
  );

  assert.match(
    selfImprove.renderSelfImproveReport("/missing", options()),
    /no self-improve outcomes/,
  );
  assert.match(
    selfImprove.renderSelfImproveTui(
      "",
      options(),
      {},
      { width: 80, height: 20 },
    ),
    /no self-improve outcomes/,
  );
});

test("self-improve execution routes interactive, internal, forwarding, and target-user modes", async () => {
  events.length = 0;
  ownerGlobal.__rinSelfImproveInteractiveOpened = true;
  process.env.RIN_DIR = "/missing-owner";
  await selfImprove.runSelfImproveInternal(["self-improve"]);
  assert.equal(
    events.some(([name]) => name === "interactive"),
    true,
  );

  ownerGlobal.__rinSelfImproveInteractiveOpened = false;
  const fallback = await captureConsole(() =>
    selfImprove.runSelfImproveInternal(["self-improve"]),
  );
  assert.match(fallback.join("\n"), /Rin self-improve history/);

  const internalJson = await captureConsole(() =>
    selfImprove.runSelfImproveInternal(["self-improve", "--json"]),
  );
  assert.equal(JSON.parse(internalJson[0]).stats.totalRuns, 0);

  const help = await captureConsole(async () => {
    assert.equal(
      selfImprove.renderSelfImproveReport("", options({ help: true })),
      "",
    );
    await selfImprove.runSelfImproveInternal(["self-improve", "--help"]);
    await selfImprove.runSelfImprove({ command: "self-improve" }, [
      "self-improve",
      "--help",
    ]);
  });
  assert.equal(
    help.filter((line) => line.includes("rin self-improve")).length,
    3,
  );

  ownerGlobal.__rinSelfImproveContext.isTargetUser = false;
  await selfImprove.runSelfImprove({ command: "self-improve" }, [
    "--user=owner",
    "self-improve",
  ]);
  assert.equal(
    events.some(([name]) => name === "exec"),
    true,
  );

  const forwarded = await captureStdout(() =>
    selfImprove.runSelfImprove({ command: "self-improve" }, [
      "--user=owner",
      "self-improve",
      "--once",
    ]),
  );
  assert.equal(forwarded, "owner-forwarded");

  ownerGlobal.__rinSelfImproveContext.isTargetUser = true;
  ownerGlobal.__rinSelfImproveContext.installDir = "/missing-owner";
  ownerGlobal.__rinSelfImproveInteractiveOpened = true;
  await selfImprove.runSelfImprove({ command: "self-improve" }, [
    "self-improve",
  ]);
  const targetOutput = await captureConsole(() =>
    selfImprove.runSelfImprove({ command: "self-improve" }, [
      "self-improve",
      "--once",
    ]),
  );
  assert.match(targetOutput[0], /Rin self-improve history/);
});
