import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const {
  collectSystemdDoctorLines,
  existingManagedSystemdUnitsForDoctor,
  renderChatBridgeDoctorLines,
  renderDaemonWorkerDoctorLines,
} = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "doctor.js")).href
);

test("rin doctor skips missing managed systemd unit candidates", () => {
  const units = ["rin-daemon-demo.service"];
  const checkedPaths: string[] = [];
  const existingUnits = existingManagedSystemdUnitsForDoctor(
    units,
    "/home/demo",
    (filePath) => {
      checkedPaths.push(filePath);
      return true;
    },
  );

  assert.deepEqual(existingUnits, ["rin-daemon-demo.service"]);
  assert.deepEqual(checkedPaths, [
    path.join(
      "/home/demo",
      ".config",
      "systemd",
      "user",
      "rin-daemon-demo.service",
    ),
  ]);

  const captured: string[][] = [];
  const lines = collectSystemdDoctorLines(
    {
      systemctl: "/usr/bin/systemctl",
      targetHome: "/home/demo",
      managedServiceUnits: units,
      capture(argv) {
        captured.push(argv);
        return argv.includes("status")
          ? "● rin-daemon-demo.service - Demo\n   Active: active (running)"
          : "recent one\nrecent two";
      },
    },
    (filePath) => filePath.endsWith("rin-daemon-demo.service"),
  );

  assert.deepEqual(
    captured.map((argv) => argv.join(" ")),
    [
      "/usr/bin/systemctl --user status rin-daemon-demo.service --no-pager -l",
      "journalctl --user -u rin-daemon-demo.service -n 20 --no-pager",
    ],
  );
  assert.deepEqual(lines, [
    "serviceUnit=rin-daemon-demo.service",
    "serviceStatus:",
    "● rin-daemon-demo.service - Demo",
    "   Active: active (running)",
    "serviceJournal=rin-daemon-demo.service",
    "recent one",
    "recent two",
  ]);

  assert.deepEqual(
    collectSystemdDoctorLines(
      {
        systemctl: "/usr/bin/systemctl",
        targetHome: "/home/demo",
        managedServiceUnits: units,
        capture() {
          throw new Error("should not touch missing unit candidates");
        },
      },
      () => false,
    ),
    [],
  );
});

test("rin doctor renderers report default daemon capability status", () => {
  assert.deepEqual(renderChatBridgeDoctorLines(undefined), [
    "chatBridgeReady=no",
    "chatBridgeAdapterCount=0",
    "chatBridgeBotCount=0",
    "chatBridgeControllerCount=0",
    "chatBridgeDetachedControllerCount=0",
  ]);

  assert.deepEqual(renderDaemonWorkerDoctorLines(undefined), []);
});

test("rin doctor renderers format daemon status details consistently", () => {
  assert.deepEqual(
    renderChatBridgeDoctorLines({
      ready: true,
      adapterCount: 1,
      botCount: 2,
      controllerCount: 3,
      detachedControllerCount: 4,
    }),
    [
      "chatBridgeReady=yes",
      "chatBridgeAdapterCount=1",
      "chatBridgeBotCount=2",
      "chatBridgeControllerCount=3",
      "chatBridgeDetachedControllerCount=4",
    ],
  );

  assert.deepEqual(
    renderDaemonWorkerDoctorLines({
      workerCount: 2,
      workers: [
        {
          id: "worker-1",
          pid: 345,
          role: "chat",
          attachedConnections: 1,
          pendingResponses: 0,
          isStreaming: true,
          isCompacting: false,
        },
      ],
    }),
    [
      "daemonWorkerCount=2",
      "daemonWorker=worker-1 pid=345 role=chat attached=1 pending=0 streaming=true compacting=false session=-",
    ],
  );
});
