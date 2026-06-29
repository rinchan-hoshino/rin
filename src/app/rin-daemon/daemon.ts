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
} from "../../core/rin-lib/profile.js";
import type { RpcSocketConnector } from "../../core/platform/rpc-socket.js";
import { RinDaemonFrontendClient } from "../../core/rin-frontend-sdk/daemon-client.js";
import {
  listBuiltInRinExtensionStatesWithLifecycle,
  setBuiltInRinExtensionState,
} from "../../core/rin-builtin-extension-controls.js";
import { loadRinAgentRuntime } from "../../core/rin-lib/agent-runtime.js";
import { applyRinSettingsDefaults } from "../../core/rin-lib/runtime.js";

type HostedChatBridge = Awaited<ReturnType<typeof startChatBridge>>;

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
  let backgroundExtensionManager: RinBackgroundExtensionManager | null = null;
  let chatBridge: HostedChatBridge | null = null;
  let chatBridgeStartupError: string | null = null;
  let servicesPromise: Promise<HostedChatBridge | null> | null = null;

  const formatHostedServiceError = (error: any) =>
    String(error?.message || error || "unknown").trim() || "unknown";

  const stopHostedServices = async () => {
    await chatBridge?.stop().catch(() => {});
  };

  const stopAllServices = async () => {
    await stopHostedServices();
    await backgroundExtensionManager?.stop().catch(() => {});
  };

  const getSettingsManager = async () => {
    const agentRuntimeModule: any = await loadRinAgentRuntime();
    const settingsManager = agentRuntimeModule.SettingsManager.create(
      runtime.cwd,
      runtime.agentDir,
    );
    applyRinSettingsDefaults(settingsManager);
    return settingsManager;
  };

  try {
    daemonLock = await acquireDaemonInstanceLock(runtime.agentDir, {
      socketPath: daemonSocketPath,
    });

    backgroundExtensionManager = new RinBackgroundExtensionManager({
      cwd: runtime.cwd,
      agentDir: runtime.agentDir,
      logger: console,
    });
    servicesPromise = (async () => {
      await backgroundExtensionManager!.start();
      try {
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
        chatBridgeStartupError = null;
        return chatBridge;
      } catch (error) {
        chatBridge = null;
        chatBridgeStartupError = formatHostedServiceError(error);
        console.error(
          `rin_app_chat_bridge_startup_failed:${chatBridgeStartupError}`,
        );
        return null;
      }
    })();
    void servicesPromise.catch(async (error) => {
      console.error(
        `rin_app_daemon_services_failed:${String(error?.message || error || "unknown")}`,
      );
      await stopAllServices().catch(() => {});
      await daemonLock?.release().catch(() => {});
      process.exit(1);
    });
    const getHostedChatBridge = async () => {
      const bridge = chatBridge || (await servicesPromise!);
      if (bridge) return bridge;
      throw new Error(
        chatBridgeStartupError
          ? `chat_bridge_unavailable:${chatBridgeStartupError}`
          : "chat_bridge_starting",
      );
    };
    const runHostedChatCommand = async (
      operation: (bridge: HostedChatBridge) => Promise<any>,
    ) => {
      try {
        return {
          success: true,
          data: await operation(await getHostedChatBridge()),
        };
      } catch (error) {
        return {
          success: false,
          error: formatHostedServiceError(error),
        };
      }
    };

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
        typing: async (payload) =>
          await (await getHostedChatBridge()).typing(payload),
        react: async (payload) =>
          await (await getHostedChatBridge()).react(payload),
        setWorkingVisible: async (payload) =>
          await (await getHostedChatBridge()).setWorkingVisible(payload),
        terminateTurn: async (payload) =>
          await (await getHostedChatBridge()).terminateTurn(payload),
      },
      getExtraStatus: () => ({
        chat: chatBridge?.getStatus() || {
          ready: false,
          status: chatBridgeStartupError ? "failed" : "starting",
          error: chatBridgeStartupError || undefined,
        },
      }),
      handleLocalCommand: async (command) => {
        const type = String(command?.type || "").trim();
        if (type === "list_builtin_extensions") {
          const settingsManager = await getSettingsManager();
          return {
            success: true,
            data: {
              extensions:
                await listBuiltInRinExtensionStatesWithLifecycle(
                  settingsManager,
                ),
            },
          };
        }
        if (type === "set_builtin_extension") {
          const settingsManager = await getSettingsManager();
          return {
            success: true,
            data: {
              extension: await setBuiltInRinExtensionState(
                settingsManager,
                String(command?.extensionId || command?.id || ""),
                Boolean(command?.enabled),
              ),
            },
          };
        }
        if (type === "chat_send") {
          return await runHostedChatCommand((bridge) =>
            bridge.send(command?.payload || {}),
          );
        }
        if (type === "chat_run_turn") {
          return await runHostedChatCommand((bridge) =>
            bridge.runTurn(command?.payload || {}),
          );
        }
        if (type === "chat_typing") {
          return await runHostedChatCommand((bridge) =>
            bridge.typing(command?.payload || {}),
          );
        }
        if (type === "chat_react") {
          return await runHostedChatCommand((bridge) =>
            bridge.react(command?.payload || {}),
          );
        }
        if (type === "chat_set_working_visible") {
          return await runHostedChatCommand((bridge) =>
            bridge.setWorkingVisible(command?.payload || {}),
          );
        }
        if (type === "chat_terminate_turn") {
          return await runHostedChatCommand((bridge) =>
            bridge.terminateTurn(command?.payload || {}),
          );
        }
        if (type === "chat_bridge_eval") {
          return await runHostedChatCommand((bridge) =>
            bridge.evalBridge(command?.payload || {}),
          );
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
