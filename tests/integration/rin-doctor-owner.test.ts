import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const doctor = await importBuiltModule<
  typeof import("../../src/core/rin/doctor.js")
>("dist/core/rin/doctor.js");

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
  const lines = doctor.renderDoctorBackendLines({
    targetUser: "owner",
    installDir: "/install",
    socketPath: "/socket",
    socketReady: true,
    serviceManager: "systemd-user",
    daemonStatus,
    chatStatus: { ready: true, adapterCount: 2, botCount: 1 },
    systemdLines: ["serviceUnit=rin-daemon-owner.service"],
  });
  assert.ok(lines.includes("socketReady=yes"));
  assert.ok(lines.includes("chatBridgeReady=yes"));
  assert.ok(lines.includes("daemonWorkerCount=1"));
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

test("doctor report presents active work and recent logs", () => {
  const report = doctor.renderDoctorReport({
    targetUser: "owner",
    installDir: "/install",
    socketPath: "/socket",
    socketReady: true,
    serviceManager: "systemd-user",
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
  assert.doesNotMatch(report, /log-0/);
  assert.match(report, /log-9/);

  const inactive = doctor.renderDoctorReport({
    targetUser: "",
    installDir: "",
    socketPath: "",
    socketReady: false,
    serviceManager: "none",
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
    assert.deepEqual(snapshot.systemdLines, []);
  } finally {
    log.mock.restore();
  }
});
