#!/usr/bin/env node
/**
 * App daemon entrypoint.
 *
 * This is intentionally only an assembly wrapper:
 * it reuses the core daemon implementation and points it at the app worker.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startChatBridge } from "../../core/chat/main.js";
import { defaultDaemonSocketPath } from "../../core/rin-lib/common.js";
import { formatRuntimeErrorForUser } from "../../core/rin-lib/user-facing-errors.js";
import { startDaemon } from "../../core/rin-daemon/daemon.js";
import { RinBackgroundExtensionManager } from "../../core/rin-daemon/extensions.js";
import {
  acquireDaemonInstanceLock,
  type DaemonInstanceLock,
} from "../../core/rin-daemon/lock.js";
import {
  applyRuntimeProfileEnvironment,
  resolveRuntimeProfile,
} from "../../core/rin-lib/runtime.js";
import type { RpcSocketConnector } from "../../core/platform/rpc-socket.js";
import {
  cleanupOrphanSearxngSidecars,
  ensureSearxngSidecar,
  stopSearxngSidecar,
} from "../../core/rin-web-search/service.js";
import { RinDaemonFrontendClient } from "../../core/rin-frontend-sdk/index.js";

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ext = path.extname(fileURLToPath(import.meta.url)) || ".js";
  const workerPath = path.join(here, `worker${ext}`);

  let localFrontendConnectorResolver:
    | ((connector: RpcSocketConnector) => void)
    | null = null;
  const localFrontendConnector = new Promise<RpcSocketConnector>((resolve) => {
    localFrontendConnectorResolver = resolve;
  });

  const runtime = resolveRuntimeProfile();
  applyRuntimeProfileEnvironment(runtime);

  const daemonSocketPath = process.argv[2] || defaultDaemonSocketPath();
  const webSearchInstanceId = `daemon-${process.pid}`;
  let daemonLock: DaemonInstanceLock | null = null;
  let backgroundExtensionManager: RinBackgroundExtensionManager | null = null;
  let chatBridge: Awaited<ReturnType<typeof startChatBridge>> | null = null;
  let servicesPromise: Promise<
    Awaited<ReturnType<typeof startChatBridge>>
  > | null = null;
  let sidecarHealthTimer: NodeJS.Timeout | null = null;
  let webSearchEnsureInFlight: Promise<void> | null = null;

  const ensureWebSearch = async () => {
    if (webSearchEnsureInFlight) return await webSearchEnsureInFlight;
    webSearchEnsureInFlight = (async () => {
      await cleanupOrphanSearxngSidecars(runtime.agentDir).catch(() => {});
      await ensureSearxngSidecar(runtime.agentDir, {
        instanceId: webSearchInstanceId,
        logger: console,
      }).catch(() => {});
    })().finally(() => {
      webSearchEnsureInFlight = null;
    });
    return await webSearchEnsureInFlight;
  };

  const stopServices = async () => {
    if (sidecarHealthTimer) clearInterval(sidecarHealthTimer);
    sidecarHealthTimer = null;
    await chatBridge?.stop().catch(() => {});
    await backgroundExtensionManager?.stop().catch(() => {});
    await stopSearxngSidecar(runtime.agentDir, {
      instanceId: webSearchInstanceId,
      logger: console,
    }).catch(() => {});
  };

  try {
    daemonLock = await acquireDaemonInstanceLock(runtime.agentDir, {
      socketPath: daemonSocketPath,
    });

    void ensureWebSearch();
    sidecarHealthTimer = setInterval(() => {
      void ensureWebSearch();
    }, 10_000);

    backgroundExtensionManager = new RinBackgroundExtensionManager({
      cwd: runtime.cwd,
      agentDir: runtime.agentDir,
      logger: console,
    });
    servicesPromise = (async () => {
      await backgroundExtensionManager!.start();
      chatBridge = await startChatBridge({
        hosted: true,
        chatAdapterProviders:
          backgroundExtensionManager!.getChatAdapterProviders(),
        frontendClientFactory: () =>
          new RinDaemonFrontendClient({
            socketPath: "inprocess://rin-daemon",
            connectSocket: async () => (await localFrontendConnector)(),
          }),
      });
      return chatBridge;
    })();
    void servicesPromise.catch(async (error) => {
      console.error(
        `rin_app_daemon_services_failed:${String(error?.message || error || "unknown")}`,
      );
      await stopServices().catch(() => {});
      await daemonLock?.release().catch(() => {});
      process.exit(1);
    });
    const getHostedChatBridge = async () => await servicesPromise!;

    await startDaemon({
      backgroundExtensionManager,
      instanceLock: daemonLock,
      socketPath: daemonSocketPath,
      workerPath,
      chat: {
        send: async (payload) =>
          await (await getHostedChatBridge()).send(payload),
        runTurn: async (payload) =>
          await (await getHostedChatBridge()).runTurn(payload),
        terminateTurn: async (payload) =>
          await (await getHostedChatBridge()).terminateTurn(payload),
      },
      getExtraStatus: () => ({
        chat: chatBridge?.getStatus() || { status: "starting" },
      }),
      handleLocalCommand: async (command) => {
        const type = String(command?.type || "").trim();
        if (type === "chat_send") {
          return {
            success: true,
            data: await (
              await getHostedChatBridge()
            ).send(command?.payload || {}),
          };
        }
        if (type === "chat_run_turn") {
          return {
            success: true,
            data: await (
              await getHostedChatBridge()
            ).runTurn(command?.payload || {}),
          };
        }
        if (type === "chat_terminate_turn") {
          return {
            success: true,
            data: await (
              await getHostedChatBridge()
            ).terminateTurn(command?.payload || {}),
          };
        }
        if (type === "chat_bridge_eval") {
          return {
            success: true,
            data: await (
              await getHostedChatBridge()
            ).evalBridge(command?.payload || {}),
          };
        }
        return undefined;
      },
      registerLocalFrontendConnector: (connector) => {
        localFrontendConnectorResolver?.(connector);
        localFrontendConnectorResolver = null;
      },
      onShutdown: stopServices,
    });
  } catch (error) {
    await stopServices().catch(() => {});
    await daemonLock?.release().catch(() => {});
    throw error;
  }
}

main().catch((error: any) => {
  console.error(formatRuntimeErrorForUser(error || "rin_app_daemon_failed"));
  process.exit(1);
});
