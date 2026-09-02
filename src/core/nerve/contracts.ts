import type { PromptContextMeta } from "../rin-lib/prompt-context.js";

export type NerveStimulusInput = {
  id?: string;
  producer: string;
  sensation: string;
  body: string;
  context?: PromptContextMeta;
};

export type NerveStoredStimulus = Required<
  Pick<NerveStimulusInput, "id" | "producer" | "sensation" | "body">
> & {
  context?: PromptContextMeta;
  createdAt: string;
  state: "queued" | "inflight" | "delivered";
};

export type NerveEmitResult = {
  stimulusId: string;
  status: "queued" | "duplicate";
};

export type NerveQueueCounts = {
  queued: number;
  inflight: number;
  delivered: number;
};

export type NerveTriggerStatus = {
  id: string;
  path: string;
  state: "starting" | "running" | "stopped" | "failed";
  pid?: number;
  error?: string;
};

export type NerveStatus = {
  ready: boolean;
  working: boolean;
  sessionFile?: string;
  queue: NerveQueueCounts;
  triggers: NerveTriggerStatus[];
};

export type NerveChatObservation = {
  chatKey: string;
  messageId: string;
  trust: string;
  text: string;
  context?: PromptContextMeta;
};
