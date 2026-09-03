import type {
  NerveEmitResult,
  NerveStatus,
  NerveStimulusInput,
  NerveStoredStimulus,
} from "./contracts.js";
import { openNerveStore } from "./store.js";
import { NERVE_SYSTEM_PROMPT } from "./system-prompt.js";
import { createNerveTriggerHost } from "./trigger-host.js";

export type NerveTurnDriverEvent = {
  type: string;
};

export type NerveTurnDriver = {
  submitTurn(input: {
    text: string;
    source: "nerve";
    requestTag: string;
    managedSessionLeaf: "nerve-main-v2";
    streamingBehavior: "steer";
    appendSystemPrompt: [string];
  }): Promise<unknown>;
  replacePendingSteer(input: {
    expectedText: string;
    text: string;
  }): Promise<boolean>;
  subscribe(listener: (event: NerveTurnDriverEvent) => void): () => void;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
  state(): Record<string, unknown>;
};

export type NerveRuntimeOptions = {
  agentDir: string;
  triggerWorkerPath: string;
  driver: NerveTurnDriver;
  startTriggers?: boolean;
};

export type NerveRuntime = {
  start(): Promise<void>;
  stop(): Promise<void>;
  emit(input: NerveStimulusInput): Promise<NerveEmitResult>;
  status(): NerveStatus;
  abort(): Promise<void>;
  reloadTrigger(id?: string): Promise<void>;
};

type StimulusBatch = {
  stimuli: NerveStoredStimulus[];
  text: string;
};

function formatBatch(stimuli: NerveStoredStimulus[]): string {
  if (stimuli.length === 1) return stimuli[0].body;
  return JSON.stringify(stimuli.map((stimulus) => stimulus.body));
}

function isNonterminal(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const value = result as Record<string, unknown>;
  return value.outcome === "nonterminal" || value.superseded === true;
}

export function createNerveRuntime(options: NerveRuntimeOptions): NerveRuntime {
  const store = openNerveStore(options.agentDir);
  let started = false;
  let stopped = false;
  let pumpScheduled = false;
  let retryTimer: NodeJS.Timeout | undefined;
  let pendingBatch: StimulusBatch | undefined;
  let completionEpoch = 0;
  let pendingWork = Promise.resolve();
  let unsubscribeDriver: (() => void) | undefined;
  const deliveries = new Map<string, Promise<void>>();

  const triggerHost = createNerveTriggerHost({
    agentDir: options.agentDir,
    workerPath: options.triggerWorkerPath,
    emit: async (input) => await runtime.emit(input),
    onTriggerError: ({ id, error }) => {
      void runtime.emit({ body: `Trigger ${id} failed:\n${error}` });
    },
  });

  const markBatchDelivered = (batch: StimulusBatch) => {
    for (const stimulus of batch.stimuli) store.markDelivered(stimulus.id);
  };

  const requeueBatch = (batch: StimulusBatch, error: unknown) => {
    for (const stimulus of batch.stimuli) store.requeue(stimulus.id, error);
  };

  const claimBatch = (): StimulusBatch | undefined => {
    const stimuli: NerveStoredStimulus[] = [];
    for (;;) {
      const stimulus = store.claimNext();
      if (!stimulus) break;
      stimuli.push(stimulus);
    }
    if (stimuli.length === 0) return undefined;
    return { stimuli, text: formatBatch(stimuli) };
  };

  const isDriverWorking = () => {
    const state = options.driver.state();
    return Boolean(state.working || state.turnActive || state.isStreaming);
  };

  const settlePendingBatch = () => {
    const batch = pendingBatch;
    if (!batch) return;
    pendingBatch = undefined;
    markBatchDelivered(batch);
  };

  const schedulePump = (delayMs = 0) => {
    if (!started || stopped) return;
    if (delayMs > 0) {
      if (retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        schedulePump();
      }, delayMs);
      retryTimer.unref?.();
      return;
    }
    if (pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      pump();
    });
  };

  const submitBatch = (batch: StimulusBatch): Promise<void> => {
    const batchKey = batch.stimuli.map((stimulus) => stimulus.id).join(":");
    const admittedAtEpoch = completionEpoch;
    const delivery = Promise.resolve()
      .then(async () => {
        const result = await options.driver.submitTurn({
          text: batch.text,
          source: "nerve",
          requestTag: `nerve:${batch.stimuli[0].id}`,
          managedSessionLeaf: "nerve-main-v2",
          streamingBehavior: "steer",
          appendSystemPrompt: [NERVE_SYSTEM_PROMPT],
        });
        if (isNonterminal(result)) {
          pendingBatch = batch;
          if (completionEpoch !== admittedAtEpoch) settlePendingBatch();
          return;
        }
        markBatchDelivered(batch);
      })
      .catch((error) => {
        requeueBatch(batch, error);
        if (!stopped) schedulePump(1_000);
      })
      .finally(() => {
        deliveries.delete(batchKey);
      });
    deliveries.set(batchKey, delivery);
    return delivery;
  };

  const updatePendingBatch = async () => {
    const additions = claimBatch();
    if (!additions) return;
    const current = pendingBatch;
    if (!current) {
      await submitBatch(additions);
      return;
    }

    const merged: StimulusBatch = {
      stimuli: [...current.stimuli, ...additions.stimuli],
      text: formatBatch([...current.stimuli, ...additions.stimuli]),
    };
    try {
      const replaced = await options.driver.replacePendingSteer({
        expectedText: current.text,
        text: merged.text,
      });
      if (replaced) {
        pendingBatch = merged;
        return;
      }
      pendingBatch = undefined;
      markBatchDelivered(current);
      await submitBatch(additions);
    } catch (error) {
      requeueBatch(additions, error);
      if (!stopped) schedulePump(1_000);
    }
  };

  const pump = () => {
    if (!started || stopped) return;
    if (deliveries.size === 0 && !pendingBatch) {
      const batch = claimBatch();
      if (batch) void submitBatch(batch);
      return;
    }
    pendingWork = pendingWork.then(updatePendingBatch, updatePendingBatch);
  };

  const runtime: NerveRuntime = {
    async start() {
      if (started) return;
      if (stopped) throw new Error("nerve_runtime_stopped");
      started = true;
      unsubscribeDriver = options.driver.subscribe((event) => {
        if (event.type === "turn_complete") {
          completionEpoch += 1;
          pendingWork = pendingWork.then(() => settlePendingBatch());
        }
      });
      try {
        if (options.startTriggers !== false) await triggerHost.start();
        schedulePump();
      } catch (error) {
        started = false;
        stopped = true;
        unsubscribeDriver?.();
        await triggerHost.stop().catch(() => {});
        store.close();
        throw error;
      }
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      started = false;
      unsubscribeDriver?.();
      unsubscribeDriver = undefined;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      await triggerHost.stop();
      if (deliveries.size > 0 || pendingBatch) {
        await options.driver.abort().catch(() => {});
      }
      await options.driver.disconnect();
      await Promise.allSettled([pendingWork, ...deliveries.values()]);
      store.close();
    },

    async emit(input) {
      if (stopped) throw new Error("nerve_runtime_stopped");
      const result = store.enqueue(input);
      schedulePump();
      return result;
    },

    status() {
      const state = options.driver.state();
      return {
        ready: started && !stopped,
        working:
          deliveries.size > 0 ||
          pendingBatch !== undefined ||
          isDriverWorking(),
        ...(typeof state.sessionFile === "string" && state.sessionFile
          ? { sessionFile: state.sessionFile }
          : {}),
        queue: store.counts(),
        triggers: triggerHost.status().triggers,
      };
    },

    async abort() {
      pendingWork = pendingWork.then(() => {
        const batch = pendingBatch;
        pendingBatch = undefined;
        if (batch) requeueBatch(batch, "nerve_aborted");
      });
      await pendingWork;
      await options.driver.abort();
      schedulePump();
    },

    async reloadTrigger(id) {
      await triggerHost.reload(id);
    },
  };

  return runtime;
}
