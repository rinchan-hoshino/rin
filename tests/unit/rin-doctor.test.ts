import test from "node:test";
import assert from "node:assert/strict";

import {
  renderChatBridgeDoctorLines,
  renderDaemonWorkerDoctorLines,
  renderWebSearchDoctorLines,
} from "../../src/core/rin/doctor.js";

test("rin doctor renderers report default daemon capability status", () => {
  assert.deepEqual(renderWebSearchDoctorLines(undefined), [
    "webSearchRuntimeReady=no",
    "webSearchMode=unknown",
    "webSearchProviderCount=0",
    "webSearchInstanceCount=0",
  ]);

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
    renderWebSearchDoctorLines({
      runtime: {
        ready: true,
        mode: "direct",
        providerCount: 2,
        providers: ["google", "duckduckgo"],
      },
      instances: [
        {
          instanceId: "primary",
          pid: 123,
          alive: true,
          port: 8080,
          baseUrl: "http://127.0.0.1:8080",
        },
      ],
    }),
    [
      "webSearchRuntimeReady=yes",
      "webSearchMode=direct",
      "webSearchProviderCount=2",
      "webSearchInstanceCount=1",
      "webSearchProvider=google",
      "webSearchProvider=duckduckgo",
      "webSearchInstance=primary pid=123 alive=yes port=8080 baseUrl=http://127.0.0.1:8080",
    ],
  );

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
