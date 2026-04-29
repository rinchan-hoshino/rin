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
import { startDaemon } from "../../core/rin-daemon/daemon.js";
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

  const chatBridge = await startChatBridge({
    hosted: true,
    frontendClientFactory: () =>
      new RinDaemonFrontendClient({
        socketPath: "inprocess://rin-daemon",
        connectSocket: async () => (await localFrontendConnector)(),
      }),
  });

  const stopServices = async () => {
    await chatBridge.stop().catch(() => {});
  };

  try {
    await startDaemon({
      workerPath,
      chat: {
        send: async (payload) => await chatBridge.send(payload),
        runTurn: async (payload) => await chatBridge.runTurn(payload),
        terminateTurn: async (payload) =>
          await chatBridge.terminateTurn(payload),
      },
      getExtraStatus: () => ({
        chat: chatBridge.getStatus(),
      }),
      handleLocalCommand: async (command) => {
        const type = String(command?.type || "").trim();
        if (type !== "chat_bridge_eval") return undefined;
        return {
          success: true,
          data: await chatBridge.evalBridge(command?.payload || {}),
        };
      },
      registerLocalFrontendConnector: (connector) => {
        localFrontendConnectorResolver?.(connector);
        localFrontendConnectorResolver = null;
      },
      onShutdown: stopServices,
    });
  } catch (error) {
    await stopServices().catch(() => {});
    throw error;
  }
}

main().catch((error: any) => {
  console.error(String(error?.message || error || "rin_app_daemon_failed"));
  process.exit(1);
});
