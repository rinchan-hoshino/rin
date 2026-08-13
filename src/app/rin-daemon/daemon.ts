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
import {
  getChatMessageRead,
  listChatMessageReads,
} from "../../core/chat/message-query.js";
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
    const getHostedChatBridge = async () => await hostedChatService.getBridge();

    await startDaemon({
      daemonExtensionManager,
      instanceLock: daemonLock,
      socketPath: daemonSocketPath,
      workerPath,
      workerCgroupIsolation,
      chat: {
        send: async (payload) =>
          await (await getHostedChatBridge()).send(payload),
        runTurn: async (payload) =>
          await (await getHostedChatBridge()).runTurn(payload),
        typing: async (payload) =>
          await (await getHostedChatBridge()).typing(payload),
        react: async (payload) =>
          await (await getHostedChatBridge()).react(payload),
        terminateTurn: async (payload) =>
          await (await getHostedChatBridge()).terminateTurn(payload),
      },
      getExtraStatus: () => ({ chat: hostedChatService.getStatus() }),
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
        if (type === "chat_typing") {
          return {
            success: true,
            data: await (
              await getHostedChatBridge()
            ).typing(command?.payload || {}),
          };
        }
        if (type === "chat_react") {
          return {
            success: true,
            data: await (
              await getHostedChatBridge()
            ).react(command?.payload || {}),
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
        if (type === "chat_message_get") {
          const payload = command?.payload || {};
          return {
            success: true,
            data:
              getChatMessageRead(
                runtime.agentDir,
                String(payload.chatKey || ""),
                String(payload.messageId || ""),
              ) || null,
          };
        }
        if (type === "chat_message_list") {
          return {
            success: true,
            data: listChatMessageReads(
              runtime.agentDir,
              command?.payload || {},
            ),
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
      onShutdown: stopHostedServices,
    });
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
