import { sleep } from "../platform/process.js";
import { safeString } from "../text-utils.js";
import {
  normalizeFrontendIdentity,
  type RinFrontendIdentity,
} from "./frontend-identity.js";
import type {
  RinFrontendClient,
  RinPromptContext,
  RinPromptOptions,
} from "./types.js";

export type RinFrontendInputSubmissionGate = {
  isCompacting?: () => boolean;
  isAborted?: () => boolean;
  abortErrorMessage?: string;
  refresh?: () => Promise<unknown>;
  onWaiting?: () => void;
  timeoutMs?: number;
  pollMs?: number;
};

function throwIfInputSubmissionAborted(gate?: RinFrontendInputSubmissionGate) {
  if (!gate?.isAborted?.()) return;
  throw new Error(gate.abortErrorMessage || "frontend_input_aborted");
}

export type RinFrontendPromptTurnInput = {
  text: string;
  images?: any[];
  source?: string;
  frontendIdentity?: RinFrontendIdentity;
  requestTag?: string;
  streamingBehavior?: "steer" | "followUp";
  promptContext?: RinPromptContext;
  sessionFile?: string;
  sessionId?: string;
  gate?: RinFrontendInputSubmissionGate;
};

export async function waitForFrontendInputSubmissionReady(
  gate?: RinFrontendInputSubmissionGate,
) {
  throwIfInputSubmissionAborted(gate);
  const isCompacting = gate?.isCompacting;
  if (!isCompacting?.()) return;
  gate?.onWaiting?.();
  const timeoutMs = gate?.timeoutMs ?? 10 * 60_000;
  const pollMs = gate?.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  while (isCompacting()) {
    throwIfInputSubmissionAborted(gate);
    if (Date.now() > deadline) throw new Error("frontend_compaction_timeout");
    await sleep(pollMs);
    await gate?.refresh?.().catch(() => undefined);
  }
  throwIfInputSubmissionAborted(gate);
}

export async function submitNativeFrontendPromptTurn(
  client: Pick<RinFrontendClient, "prompt">,
  input: RinFrontendPromptTurnInput,
): Promise<void> {
  await waitForFrontendInputSubmissionReady(input.gate);
  throwIfInputSubmissionAborted(input.gate);
  const promptOptions: RinPromptOptions = {
    images: input.images,
    streamingBehavior: input.streamingBehavior,
    source: input.source,
    requestTag: input.requestTag,
  };
  const frontendIdentity = normalizeFrontendIdentity(input.frontendIdentity);
  if (frontendIdentity) promptOptions.frontendIdentity = frontendIdentity;
  if (input.promptContext) promptOptions.promptContext = input.promptContext;
  const sessionFile = safeString(input.sessionFile || "").trim();
  if (sessionFile) promptOptions.sessionFile = sessionFile;
  const sessionId = safeString(input.sessionId || "").trim();
  if (sessionId) promptOptions.sessionId = sessionId;
  await client.prompt(input.text, promptOptions);
}
