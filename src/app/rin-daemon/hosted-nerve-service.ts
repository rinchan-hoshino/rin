import { fileURLToPath } from "node:url";

import type {
  RinRpcCommandEnvelope,
  RinRpcCommandResult,
  RinRpcCommandRouter,
  RinRpcCommandType,
} from "../../core/rin-lib/rpc-types.js";
import { RinDaemonFrontendClient } from "../../core/rin-frontend-sdk/daemon-client.js";
import { RinFrontendTurnDriver } from "../../core/rin-frontend-sdk/turn-driver.js";
import type { RpcSocketConnector } from "../../core/platform/rpc-socket.js";
import type { NerveStimulusInput } from "../../core/nerve/contracts.js";
import {
  createNerveRuntime,
  type NerveRuntime,
} from "../../core/nerve/runtime.js";

function success(data: unknown): RinRpcCommandResult {
  return { success: true, data };
}

function payload<T>(command: RinRpcCommandEnvelope): T {
  return (command.payload || {}) as T;
}

export function createHostedNerveService(options: {
  agentDir: string;
  logger?: Pick<Console, "warn" | "error">;
}) {
  let runtime: NerveRuntime | null = null;
  let startPromise: Promise<void> | null = null;

  const requireRuntime = async () => {
    if (startPromise) await startPromise;
    if (!runtime) throw new Error("nerve_runtime_unavailable");
    return runtime;
  };

  const handlers = {
    nerve_emit: async (command) =>
      success(
        await (
          await requireRuntime()
        ).emit(payload<NerveStimulusInput>(command)),
      ),
    nerve_status: async () => success((await requireRuntime()).status()),
    nerve_abort: async () => {
      await (await requireRuntime()).abort();
      return success({ aborted: true });
    },
    nerve_reload_trigger: async (command) => {
      const input = payload<{ id?: string }>(command);
      await (await requireRuntime()).reloadTrigger(input.id);
      return success((await requireRuntime()).status());
    },
  } satisfies Partial<
    Record<
      RinRpcCommandType,
      (command: RinRpcCommandEnvelope) => Promise<RinRpcCommandResult>
    >
  >;

  const commandRouter: RinRpcCommandRouter = async (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const command = value as RinRpcCommandEnvelope;
    const type = String(command.type || "").trim() as keyof typeof handlers;
    const handler = handlers[type];
    return handler ? await handler(command) : undefined;
  };

  return {
    commandRouter,
    async start(connectSocket: RpcSocketConnector) {
      if (startPromise) return await startPromise;
      startPromise = (async () => {
        const frontendIdentity = { kind: "nerve", key: "main" } as const;
        const driver = new RinFrontendTurnDriver({
          frontendIdentity,
          promptSource: "nerve",
          clientFactory: () =>
            new RinDaemonFrontendClient({
              frontendIdentity,
              socketPath: "inprocess://rin-daemon",
              connectSocket,
            }),
        });
        runtime = createNerveRuntime({
          agentDir: options.agentDir,
          triggerWorkerPath: fileURLToPath(
            new URL("./nerve-trigger-worker.js", import.meta.url),
          ),
          driver: {
            submitTurn: async (input) => await driver.submitTurn(input),
            abort: async () => {
              await driver.abortCurrentTurn();
            },
            disconnect: async () => driver.dispose(),
            state: () => ({
              sessionFile: driver.currentSessionFile(),
              turnActive: driver.hasActiveTurn(),
              working: driver.isWorking(),
            }),
          },
        });
        await runtime.start();
      })().catch((error) => {
        runtime = null;
        startPromise = null;
        options.logger?.error?.(
          `[rin-nerve] startup failed: ${String(error?.stack || error)}`,
        );
        throw error;
      });
      await startPromise;
    },
    getStatus() {
      return runtime
        ? runtime.status()
        : {
            ready: false,
            working: false,
            queue: { queued: 0, inflight: 0, delivered: 0 },
            triggers: [],
          };
    },
    async stop() {
      if (startPromise) await startPromise.catch(() => {});
      const current = runtime;
      runtime = null;
      startPromise = null;
      await current?.stop();
    },
  };
}
