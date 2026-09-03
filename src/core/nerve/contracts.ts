export type NerveStimulusInput = {
  dedupeKey?: string;
  body: string;
};

export type NerveStimulusState = "queued" | "inflight" | "delivered";

export type NerveStoredStimulus = {
  id: string;
  dedupeKey?: string;
  body: string;
  bodyHash: string;
  state: NerveStimulusState;
  createdAt: string;
  deliveredAt?: string;
  lastError?: string;
};

export type NerveEmitResult = {
  stimulusId: string;
  status: "queued" | "duplicate";
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
  queue: {
    queued: number;
    inflight: number;
    delivered: number;
  };
  triggers: NerveTriggerStatus[];
};

export type NerveTriggerContext = {
  triggerId: string;
  stateDir: string;
  signal: AbortSignal;
  emit(input: NerveStimulusInput): Promise<NerveEmitResult>;
  sleepFor(milliseconds: number): Promise<void>;
  sleepUntil(time: string | Date): Promise<void>;
};
