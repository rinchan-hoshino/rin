import type {
  NerveChatObservation,
  NerveEmitResult,
  NerveStatus,
  NerveStimulusInput,
} from "./contracts.js";
import type { PromptContextMeta } from "../rin-lib/prompt-context.js";
import { NERVE_SYSTEM_PROMPT } from "./system-prompt.js";
import { openNerveStore } from "./store.js";
import { createNerveTriggerHost } from "./trigger-host.js";

export type NerveTurnDriver = {
  submitTurn(input: {
    text: string;
    source: "nerve";
    requestTag: string;
    managedSessionLeaf: "nerve-main";
    streamingBehavior: "steer";
    disabledRinCapabilities: ["self_improve"];
    appendSystemPrompt: [string];
    promptContext?: PromptContextMeta;
  }): Promise<unknown>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
  state(): Record<string, unknown>;
};

function renderStimulus(input: {
  id: string;
  producer: string;
  sensation: string;
  body: string;
  createdAt: string;
}) {
  return [
    `Stimulus ID: ${input.id}`,
    `Producer: ${input.producer}`,
    `Occurred at: ${input.createdAt}`,
    `You felt “${input.sensation}”:`,
    input.body,
  ].join("\n");
}

export function createNerveRuntime(options: {
  agentDir: string;
  driver: NerveTurnDriver;
  ownerChatKey?: string;
  startTriggers?: boolean;
  triggerWorkerPath: string;
}) {
  const store = openNerveStore(options.agentDir);
  const ownerChatKey = String(options.ownerChatKey || "");
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
        id: `trigger-error:${id}:${Date.now()}`,
        producer: "nerve-runtime",
        sensation: "trigger_error",
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
            text: renderStimulus(stimulus),
            source: "nerve",
            requestTag: `nerve:${stimulus.id}`,
            managedSessionLeaf: "nerve-main",
            streamingBehavior: "steer",
            disabledRinCapabilities: ["self_improve"],
            appendSystemPrompt: [NERVE_SYSTEM_PROMPT],
            promptContext: stimulus.context,
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
    async observeChat(input: NerveChatObservation) {
      if (!ownerChatKey || input.chatKey !== ownerChatKey) {
        return { handled: false, stimulated: false };
      }
      if (String(input.trust || "").toUpperCase() !== "OWNER") {
        return { handled: true, stimulated: false };
      }
      await runtime.emit({
        id: `chat:${input.chatKey}:${input.messageId}`,
        producer: "owner-chat",
        sensation: "owner_message",
        body: input.text,
        context: input.context,
      });
      return { handled: true, stimulated: true };
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
