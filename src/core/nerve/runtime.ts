import type {
  NerveEmitResult,
  NerveStatus,
  NerveStimulusInput,
} from "./contracts.js";
import { NERVE_SYSTEM_PROMPT } from "./system-prompt.js";
import { openNerveStore } from "./store.js";
import { createNerveTriggerHost } from "./trigger-host.js";

export type NerveTurnDriver = {
  submitTurn(input: {
    text: string;
    source: "nerve";
    requestTag: string;
    managedSessionLeaf: "nerve-main-v2";
    streamingBehavior: "steer";
    disabledRinCapabilities: ["self_improve"];
    appendSystemPrompt: [string];
  }): Promise<unknown>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
  state(): Record<string, unknown>;
};

export function createNerveRuntime(options: {
  agentDir: string;
  driver: NerveTurnDriver;
  startTriggers?: boolean;
  triggerWorkerPath: string;
}) {
  const store = openNerveStore(options.agentDir);
  let started = false;
  let stopped = false;
  let pumping = false;
  let pumpRequested = false;
  let retryTimer: NodeJS.Timeout | undefined;
  const triggerHost = createNerveTriggerHost({
    agentDir: options.agentDir,
    workerPath: options.triggerWorkerPath,
    emit: async (input) => await runtime.emit(input),
    onTriggerError: ({ id, error }) => {
      void runtime.emit({
        dedupeKey: `trigger-error:${id}:${Date.now()}`,
        body: `Trigger ${id} failed:\n${error}`,
      });
    },
  });

  const schedulePump = (delayMs = 0) => {
    if (!started || stopped) return;
    if (delayMs > 0) {
      if (retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        schedulePump();
      }, delayMs);
      return;
    }
    pumpRequested = true;
    queueMicrotask(() => void pump());
  };

  const pump = async () => {
    if (pumping || !started || stopped) return;
    pumping = true;
    pumpRequested = false;
    try {
      for (;;) {
        const stimulus = store.claimNext();
        if (!stimulus) break;
        try {
          await options.driver.submitTurn({
            text: stimulus.body,
            source: "nerve",
            requestTag: `nerve:${stimulus.id}`,
            managedSessionLeaf: "nerve-main-v2",
            streamingBehavior: "steer",
            disabledRinCapabilities: ["self_improve"],
            appendSystemPrompt: [NERVE_SYSTEM_PROMPT],
          });
          store.markDelivered(stimulus.id);
        } catch (error) {
          store.requeue(stimulus.id, error);
          schedulePump(1_000);
          break;
        }
      }
    } finally {
      pumping = false;
      if (pumpRequested) schedulePump();
    }
  };

  const runtime = {
    async start() {
      if (started) return;
      stopped = false;
      started = true;
      try {
        if (options.startTriggers !== false) await triggerHost.start();
        schedulePump();
      } catch (error) {
        started = false;
        stopped = true;
        await triggerHost.stop().catch(() => {});
        store.close();
        throw error;
      }
    },
    async emit(input: NerveStimulusInput): Promise<NerveEmitResult> {
      if (stopped) throw new Error("nerve_runtime_stopped");
      const result = store.enqueue(input);
      schedulePump();
      return result;
    },
    status(): NerveStatus {
      const state = options.driver.state();
      return {
        ready: started && !stopped,
        working: Boolean(
          state.working || state.turnActive || state.isStreaming,
        ),
        ...(typeof state.sessionFile === "string" && state.sessionFile
          ? { sessionFile: state.sessionFile }
          : {}),
        queue: store.counts(),
        triggers: triggerHost.status().triggers,
      };
    },
    async abort() {
      await options.driver.abort();
    },
    async reloadTrigger(id?: string) {
      await triggerHost.reload(id);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      started = false;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      await triggerHost.stop();
      await options.driver.disconnect();
      store.close();
    },
  };
  return runtime;
}

export type NerveRuntime = ReturnType<typeof createNerveRuntime>;
