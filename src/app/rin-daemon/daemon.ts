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
import { startDaemon } from "../../core/rin-daemon/daemon.js";
import { RinDaemonExtensionManager } from "../../core/rin-daemon/extensions.js";
import {
  acquireDaemonInstanceLock,
  type DaemonInstanceLock,
} from "../../core/rin-daemon/lock.js";
import {
  applyRuntimeProfileEnvironment,
  resolveRuntimeProfile,
} from "../../core/rin-lib/runtime.js";
import type { RpcSocketConnector } from "../../core/platform/rpc-socket.js";
import { RinDaemonFrontendClient } from "../../core/rin-tui/rpc-client.js";

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
  let daemonLock: DaemonInstanceLock | null = null;
  let daemonExtensionManager: RinDaemonExtensionManager | null = null;
  let chatBridge: Awaited<ReturnType<typeof startChatBridge>> | null = null;

  const stopServices = async () => {
    await chatBridge?.stop().catch(() => {});
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
    await daemonExtensionManager.start();

    chatBridge = await startChatBridge({
      hosted: true,
      chatAdapterProviders: daemonExtensionManager.getChatAdapterProviders(),
      frontendClientFactory: () =>
        new RinDaemonFrontendClient({
          socketPath: "inprocess://rin-daemon",
          connectSocket: async () => (await localFrontendConnector)(),
        }),
    });
    const hostedChatBridge = chatBridge;

    await startDaemon({
      daemonExtensionManager,
      instanceLock: daemonLock,
      socketPath: daemonSocketPath,
      workerPath,
      chat: {
        send: async (payload) => await hostedChatBridge.send(payload),
        runTurn: async (payload) => await hostedChatBridge.runTurn(payload),
        terminateTurn: async (payload) =>
          await hostedChatBridge.terminateTurn(payload),
      },
      getExtraStatus: () => ({
        chat: hostedChatBridge.getStatus(),
      }),
      handleLocalCommand: async (command) => {
        const type = String(command?.type || "").trim();
        if (type === "chat_send") {
          return {
            success: true,
            data: await hostedChatBridge.send(command?.payload || {}),
          };
        }
        if (type === "chat_run_turn") {
          return {
            success: true,
            data: await hostedChatBridge.runTurn(command?.payload || {}),
          };
        }
        if (type === "chat_terminate_turn") {
          return {
            success: true,
            data: await hostedChatBridge.terminateTurn(command?.payload || {}),
          };
        }
        if (type === "chat_bridge_eval") {
          return {
            success: true,
            data: await hostedChatBridge.evalBridge(command?.payload || {}),
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
  console.error(String(error?.message || error || "rin_app_daemon_failed"));
  process.exit(1);
});
