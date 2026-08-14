#!/usr/bin/env node
/**
 * App daemon entrypoint.
 *
 * This is intentionally only an assembly wrapper:
 * it reuses the core daemon implementation and points it at the app worker.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createChatDaemonIntegration } from "../../core/chat/daemon-integration.js";
import { startChatBridge } from "../../core/chat/main.js";
import { defaultDaemonSocketPath } from "../../core/rin-lib/common.js";
import { formatRuntimeErrorForUser } from "../../core/presentation/error.js";
import { startDaemon } from "../../core/rin-daemon/daemon.js";
import { RinDaemonExtensionManager } from "../../core/rin-daemon/extensions.js";
import { createWorkerCgroupIsolation } from "../../core/rin-daemon/worker-cgroup-isolation.js";
import {
  acquireDaemonInstanceLock,
  type DaemonInstanceLock,
} from "../../core/rin-daemon/lock.js";
import {
  applyRuntimeProfileEnvironment,
  resolveRuntimeProfile,
} from "../../core/rin-lib/profile.js";
import type { RpcSocketConnector } from "../../core/platform/rpc-socket.js";
import { RinDaemonFrontendClient } from "../../core/rin-frontend-sdk/daemon-client.js";
import { createHostedChatService } from "./hosted-chat-service.js";

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ext = path.extname(fileURLToPath(import.meta.url)) || ".js";
  const workerPath = path.join(here, `worker${ext}`);
  const selfImproveWorkerPath = path.join(here, `self-improve-worker${ext}`);

  let localFrontendConnectorResolver:
    | ((connector: RpcSocketConnector) => void)
    | null = null;
  const localFrontendConnector = new Promise<RpcSocketConnector>((resolve) => {
    localFrontendConnectorResolver = resolve;
  });

  const runtime = resolveRuntimeProfile();
  applyRuntimeProfileEnvironment(runtime);
  const workerCgroupIsolation = createWorkerCgroupIsolation({
    warn: (message) => console.warn(message),
  });

  const daemonSocketPath = process.argv[2] || defaultDaemonSocketPath();
  let daemonLock: DaemonInstanceLock | null = null;
  let daemonExtensionManager: RinDaemonExtensionManager | null = null;
  const hostedChatService = createHostedChatService({ logger: console });
  const getHostedChatBridge = async () => await hostedChatService.getBridge();
  const chatIntegration = createChatDaemonIntegration({
    agentDir: runtime.agentDir,
    getBridge: getHostedChatBridge,
  });

  const stopHostedServices = async () => {
    await hostedChatService.stop();
  };

  const stopAllServices = async () => {
    await stopHostedServices();
    await daemonExtensionManager?.stop().catch(() => {});
  };

  try {
    daemonLock = await acquireDaemonInstanceLock(runtime.agentDir, {
      socketPath: daemonSocketPath,
    });

    daemonExtensionManager = new RinDaemonExtensionManager({
      cwd: runtime.cwd,
      agentDir: runtime.agentDir,
      logger: console,
    });
    daemonExtensionManager.setChatApi(chatIntegration.extensionApi);
    const daemonExtensionStartPromise = daemonExtensionManager.start();
    void hostedChatService.start(async () => {
      await daemonExtensionStartPromise;
      return await startChatBridge({
        hosted: true,
        chatAdapterProviders: daemonExtensionManager!.getChatAdapterProviders(),
        frontendClientFactory: () =>
          new RinDaemonFrontendClient({
            socketPath: "inprocess://rin-daemon",
            connectSocket: async () => (await localFrontendConnector)(),
          }),
      });
    });

    const daemon = await startDaemon({
      daemonExtensionManager,
      instanceLock: daemonLock,
      socketPath: daemonSocketPath,
      workerPath,
      selfImproveWorkerPath,
      workerCgroupIsolation,
      chat: chatIntegration.delivery,
      chatExtensionApi: chatIntegration.extensionApi,
      additionalCommandRouter: chatIntegration.commandRouter,
      getExtraStatus: () => ({ chat: hostedChatService.getStatus() }),
      registerLocalFrontendConnector: (connector) => {
        localFrontendConnectorResolver?.(connector);
        localFrontendConnectorResolver = null;
      },
      onShutdown: stopHostedServices,
    });
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      try {
        await daemon.shutdown();
        process.exit(0);
      } catch (error) {
        console.error(formatRuntimeErrorForUser(error));
        process.exit(1);
      }
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  } catch (error) {
    await stopAllServices().catch(() => {});
    await daemonLock?.release().catch(() => {});
    throw error;
  }
}

main().catch((error: any) => {
  console.error(formatRuntimeErrorForUser(error || "rin_app_daemon_failed"));
  process.exit(1);
});
