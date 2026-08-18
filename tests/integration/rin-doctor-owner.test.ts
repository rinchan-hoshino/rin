import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const doctor = await importBuiltModule<
  typeof import("../../src/core/rin/doctor.js")
>("dist/core/rin/doctor.js");
const transcripts = await importBuiltModule<
  typeof import("../../src/core/memory/transcripts.js")
>("dist/core/memory/transcripts.js");
const transcriptSearch = await importBuiltModule<
  typeof import("../../src/core/memory/transcript-search.js")
>("dist/core/memory/transcript-search.js");
const BetterSqlite3 = (await import("better-sqlite3")).default;

test("doctor CLI parsing accepts its two flags and rejects unknown input", () => {
  assert.deepEqual(doctor.parseDoctorArgs(["doctor"]), {
    json: false,
    help: false,
  });
  assert.deepEqual(doctor.parseDoctorArgs(["rin", "doctor", "--json", "-h"]), {
    json: true,
    help: true,
  });
  assert.throws(
    () => doctor.parseDoctorArgs(["doctor", "--unknown"]),
    /unknown_doctor_arg:--unknown/,
  );
});

test("doctor backend lines normalize absent and populated daemon state", () => {
  assert.deepEqual(doctor.renderDaemonWorkerDoctorLines(null), []);
  assert.deepEqual(doctor.renderChatBridgeDoctorLines(null), [
    "chatBridgeReady=no",
    "chatBridgeAdapterCount=0",
    "chatBridgeBotCount=0",
    "chatBridgeControllerCount=0",
    "chatBridgeDetachedControllerCount=0",
  ]);
  const daemonStatus = {
    workerCount: 1,
    workers: [
      {
        id: "worker-1",
        pid: 12,
        role: "foreground",
        attachedConnections: 1,
        pendingResponses: 0,
        isStreaming: true,
        isCompacting: false,
      },
    ],
  };
  assert.match(
    doctor.renderDaemonWorkerDoctorLines(daemonStatus)[1],
    /session=-/,
  );
  const snapshot = {
    targetUser: "owner",
    installDir: "/install",
    socketPath: "/socket",
    socketReady: true,
    serviceManager: "systemd-user",
    memoryIndex: {
      status: "ready",
      dbPresent: true,
      schemaVersion: 6,
      expectedSchemaVersion: 6,
      schemaMarkerState: "current",
      rebuildRequired: false,
      dirtyMarkerCount: 0,
      staleDirtyMarkerCount: 0,
      reasons: [],
    },
    daemonStatus,
    chatStatus: { ready: true, adapterCount: 2, botCount: 1 },
    systemdLines: ["serviceUnit=rin-daemon-owner.service"],
  } satisfies Parameters<typeof doctor.renderDoctorBackendLines>[0];
  const lines = doctor.renderDoctorBackendLines(snapshot);
  assert.ok(lines.includes("socketReady=yes"));
  assert.ok(lines.includes("memoryIndexStatus=ready"));
  assert.ok(lines.includes("chatBridgeReady=yes"));
  assert.ok(lines.includes("daemonWorkerCount=1"));
  assert.match(
    doctor.renderDoctorReport(snapshot),
    /Memory index: ready \(schema 6\)/,
  );
  const degradedLines = doctor.renderDoctorBackendLines({
    ...snapshot,
    memoryIndex: {
      ...snapshot.memoryIndex,
      status: "degraded",
      rebuildRequired: true,
      reasons: ["rebuild-required"],
    },
  });
  assert.ok(degradedLines.includes("memoryIndexRebuildRequired=yes"));
  assert.ok(degradedLines.includes("memoryIndexReasons=rebuild-required"));
});

test("doctor systemd collection chooses installed units and bounded snapshots", () => {
  const captured: string[][] = [];
  const context: any = {
    systemctl: "/usr/bin/systemctl",
    isTargetUser: true,
    targetHome: "/home/owner",
    managedServiceUnits: ["missing.service", "rin.service"],
    capture(argv: string[]) {
      captured.push(argv);
      if (argv.includes("missing.service")) throw new Error("missing");
      if (argv[0] === "journalctl") return "old\nlatest\n";
      return "Active: active (running)\n";
    },
  };
  assert.deepEqual(
    doctor.existingManagedSystemdUnitsForDoctor(
      context.managedServiceUnits,
      context.targetHome,
      (filePath) => filePath.endsWith("rin.service"),
    ),
    ["rin.service"],
  );
  const lines = doctor.collectSystemdDoctorLines(context, (filePath) =>
    filePath.endsWith("rin.service"),
  );
  assert.deepEqual(lines, [
    "serviceUnit=rin.service",
    "serviceStatus:",
    "Active: active (running)",
    "serviceJournal=rin.service",
    "old",
    "latest",
  ]);
  assert.equal(captured.length, 2);
  assert.deepEqual(
    doctor.collectSystemdDoctorLines({ ...context, systemctl: "" }),
    [],
  );
  assert.deepEqual(
    doctor.collectSystemdDoctorLines(context, () => false),
    [],
  );
});

test("doctor memory-index inspection is read-only and reports degraded state", async () => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "rin-doctor-memory-"),
  );
  try {
    assert.deepEqual(transcriptSearch.inspectTranscriptSearchHealth(root), {
      status: "uninitialized",
      dbPresent: false,
      schemaVersion: null,
      expectedSchemaVersion: 6,
      schemaMarkerState: "missing",
      rebuildRequired: null,
      dirtyMarkerCount: 0,
      staleDirtyMarkerCount: 0,
      reasons: [],
    });

    await transcripts.searchTranscriptArchive(
      "initialize an empty derived index",
      { limit: 1 },
      root,
    );
    assert.equal(
      transcriptSearch.inspectTranscriptSearchHealth(root).status,
      "ready",
    );

    const memoryDir = path.join(root, "memory");
    const dbPath = path.join(memoryDir, "search.db");
    const markerPath = `${dbPath}.schema.json`;
    await fs.promises.rm(markerPath);
    const missingMarker = transcriptSearch.inspectTranscriptSearchHealth(root);
    assert.equal(missingMarker.schemaMarkerState, "missing");
    assert.ok(missingMarker.reasons.includes("schema-marker-missing"));
    await fs.promises.writeFile(markerPath, "{}\n");
    const invalidMarker = transcriptSearch.inspectTranscriptSearchHealth(root);
    assert.equal(invalidMarker.schemaMarkerState, "invalid");
    assert.ok(invalidMarker.reasons.includes("schema-marker-invalid"));
    await fs.promises.writeFile(
      markerPath,
      `${JSON.stringify({ schemaVersion: 6, state: "installer-migrating" })}\n`,
    );
    const migratingMarker =
      transcriptSearch.inspectTranscriptSearchHealth(root);
    assert.equal(migratingMarker.schemaMarkerState, "installer-migrating");
    assert.ok(
      migratingMarker.reasons.includes("schema-marker-installer-migrating"),
    );
    await fs.promises.writeFile(
      markerPath,
      `${JSON.stringify({ schemaVersion: 6, state: "current" })}\n`,
    );

    const db = new BetterSqlite3(dbPath);
    db.prepare(
      "UPDATE metadata SET value = '1' WHERE key = 'rebuild_required'",
    ).run();
    db.close();
    const rebuildHealth = transcriptSearch.inspectTranscriptSearchHealth(root);
    assert.equal(rebuildHealth.status, "degraded");
    assert.equal(rebuildHealth.rebuildRequired, true);
    assert.ok(rebuildHealth.reasons.includes("rebuild-required"));

    await fs.promises.rm(`${dbPath}-wal`, { force: true });
    await fs.promises.rm(`${dbPath}-shm`, { force: true });
    await fs.promises.writeFile(dbPath, "not a sqlite database");
    const dirtyPath = path.join(
      memoryDir,
      "search-writers",
      "failed-writer.dirty",
    );
    await fs.promises.mkdir(path.dirname(dirtyPath), { recursive: true });
    await fs.promises.writeFile(
      dirtyPath,
      `${JSON.stringify({ pid: process.pid, failed: true })}\n`,
    );
    const beforeDb = await fs.promises.readFile(dbPath);
    const beforeMarker = await fs.promises.readFile(markerPath);
    const beforeDirty = await fs.promises.readFile(dirtyPath);

    const health = transcriptSearch.inspectTranscriptSearchHealth(root);

    assert.equal(health.status, "degraded");
    assert.equal(health.dirtyMarkerCount, 1);
    assert.equal(health.staleDirtyMarkerCount, 1);
    assert.ok(health.reasons.includes("stale-writer-marker"));
    assert.ok(health.reasons.includes("database-unreadable"));
    assert.deepEqual(await fs.promises.readFile(dbPath), beforeDb);
    assert.deepEqual(await fs.promises.readFile(markerPath), beforeMarker);
    assert.deepEqual(await fs.promises.readFile(dirtyPath), beforeDirty);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("doctor report presents active work and recent logs", () => {
  const report = doctor.renderDoctorReport({
    targetUser: "owner",
    installDir: "/install",
    socketPath: "/socket",
    socketReady: true,
    serviceManager: "systemd-user",
    memoryIndex: {
      status: "degraded",
      dbPresent: true,
      schemaVersion: 6,
      expectedSchemaVersion: 6,
      schemaMarkerState: "current",
      rebuildRequired: true,
      dirtyMarkerCount: 1,
      staleDirtyMarkerCount: 1,
      reasons: ["rebuild-required", "stale-writer-marker"],
    },
    daemonStatus: {
      workers: [
        { state: "working" },
        { state: "stopping" },
        { state: "idle", isStreaming: true },
        { state: "idle" },
      ],
    },
    chatStatus: { ready: true, botCount: 1, adapterCount: 2 },
    systemdLines: [
      "serviceUnit=rin-owner.service",
      "serviceJournal=rin-owner.service",
      ...Array.from({ length: 10 }, (_, index) => `log-${index}`),
    ],
  });
  assert.match(report, /● rin-owner\.service/);
  assert.match(report, /4 total, 3 active/);
  assert.match(report, /Chat bridge: ready \(1 bots, 2 adapters\)/);
  assert.match(
    report,
    /Memory index: degraded \(rebuild-required, stale-writer-marker\)/,
  );
  assert.doesNotMatch(report, /log-0/);
  assert.match(report, /log-9/);

  const inactive = doctor.renderDoctorReport({
    targetUser: "",
    installDir: "",
    socketPath: "",
    socketReady: false,
    serviceManager: "none",
    memoryIndex: {
      status: "uninitialized",
      dbPresent: false,
      schemaVersion: null,
      expectedSchemaVersion: 6,
      schemaMarkerState: "missing",
      rebuildRequired: null,
      dirtyMarkerCount: 0,
      staleDirtyMarkerCount: 0,
      reasons: [],
    },
    systemdLines: [],
  });
  assert.match(inactive, /inactive \(dead\)/);
  assert.match(inactive, /not-found/);
});

test("doctor command renders help and an isolated JSON snapshot", async () => {
  const output: string[] = [];
  const log = mock.method(console, "log", (value: unknown) => {
    output.push(String(value));
  });
  try {
    await doctor.runDoctor({} as any, ["doctor", "--help"]);
    assert.match(output.pop() || "", /rin doctor \[options\]/);

    const exists = mock.method(fs, "existsSync", (filePath: fs.PathLike) => {
      return !String(filePath).endsWith(".service");
    });
    try {
      await doctor.runDoctor(
        {
          targetUser: os.userInfo().username,
          installDir: path.join(os.tmpdir(), "rin-doctor-owner-install"),
        } as any,
        ["doctor", "--json"],
      );
    } finally {
      exists.mock.restore();
    }
    const snapshot = JSON.parse(output.pop() || "{}");
    assert.equal(snapshot.targetUser, os.userInfo().username);
    assert.equal(snapshot.socketReady, false);
    assert.ok(
      ["ready", "uninitialized", "degraded"].includes(
        snapshot.memoryIndex.status,
      ),
    );
    assert.deepEqual(snapshot.systemdLines, []);
  } finally {
    log.mock.restore();
  }
});
