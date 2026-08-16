import { safeString } from "../text-utils.js";

export type WorkingIndicatorKind = "polling" | "marker";
export type WorkingIndicatorPresentation =
  | "typing"
  | "editable-message"
  | "reaction"
  | "message"
  | "legacy";

export type WorkingIndicatorContext = Record<string, unknown>;
export type WorkingIndicatorHandler = (
  context: WorkingIndicatorContext,
) => Promise<unknown> | unknown;

export type WorkingIndicator = {
  type?: string;
  kind?: string;
  name?: string;
  presentation?: string;
  capability?: string;
  priority?: number;
  tick?: WorkingIndicatorHandler;
  end?: WorkingIndicatorHandler;
  start?: WorkingIndicatorHandler;
  onTick?: WorkingIndicatorHandler;
  onEnd?: WorkingIndicatorHandler;
  onStart?: WorkingIndicatorHandler;
};

const WORKING_PRESENTATION_PRIORITY: Record<
  WorkingIndicatorPresentation,
  number
> = {
  typing: -1,
  "editable-message": 300,
  reaction: 200,
  message: 100,
  legacy: 0,
};

const PLATFORM_POLL_INTERVAL_MS: Record<string, number> = {
  // Telegram Bot API sendChatAction expires after 5 seconds.
  telegram: 4_000,
  // Discord typing indicators expire after 10 seconds.
  discord: 9_000,
};
const DEFAULT_POLL_INTERVAL_MS = 30_000;

export function workingIndicatorKind(indicator: WorkingIndicator) {
  const kind = safeString(indicator?.type || indicator?.kind).trim();
  return kind === "polling" || kind === "marker" ? kind : "";
}

export function workingIndicatorPresentation(
  indicator: WorkingIndicator,
): WorkingIndicatorPresentation {
  const value = safeString(
    indicator?.presentation || indicator?.capability,
  ).trim();
  if (
    value === "typing" ||
    value === "editable-message" ||
    value === "reaction" ||
    value === "message"
  ) {
    return value;
  }
  return "legacy";
}

function workingIndicatorPriority(indicator: WorkingIndicator) {
  const explicit = Number(indicator?.priority);
  if (Number.isFinite(explicit)) return explicit;
  return WORKING_PRESENTATION_PRIORITY[workingIndicatorPresentation(indicator)];
}

function pickVisibleWorkingIndicator(indicators: WorkingIndicator[]) {
  const visible = indicators.filter(
    (indicator) => workingIndicatorPresentation(indicator) !== "typing",
  );
  if (!visible.length) return null;
  const typed = visible.filter(
    (indicator) => workingIndicatorPresentation(indicator) !== "legacy",
  );
  const candidates = typed.length ? typed : visible;
  return candidates.reduce((best, indicator) =>
    workingIndicatorPriority(indicator) > workingIndicatorPriority(best)
      ? indicator
      : best,
  );
}

export function selectTypingIndicatorsForKind(
  indicators: WorkingIndicator[],
  kind: WorkingIndicatorKind,
) {
  return indicators.filter(
    (indicator) =>
      workingIndicatorKind(indicator) === kind &&
      workingIndicatorPresentation(indicator) === "typing",
  );
}

export function selectVisibleWorkingIndicatorsForKind(
  indicators: WorkingIndicator[],
  kind: WorkingIndicatorKind,
) {
  const visible = pickVisibleWorkingIndicator(indicators);
  return visible && workingIndicatorKind(visible) === kind ? [visible] : [];
}

export function selectWorkingIndicatorsForKind(
  indicators: WorkingIndicator[],
  kind: WorkingIndicatorKind,
) {
  return [
    ...selectTypingIndicatorsForKind(indicators, kind),
    ...selectVisibleWorkingIndicatorsForKind(indicators, kind),
  ];
}

export function selectWorkingIndicatorsForEnd(indicators: WorkingIndicator[]) {
  const visible = pickVisibleWorkingIndicator(indicators);
  return visible ? [visible] : [];
}

export function normalizeWorkingIndicators(value: unknown): WorkingIndicator[] {
  const raw = Array.isArray(value) ? value : [];
  return raw.filter(
    (indicator): indicator is WorkingIndicator =>
      indicator &&
      typeof indicator === "object" &&
      Boolean(workingIndicatorKind(indicator as WorkingIndicator)),
  );
}

export function workingIndicatorPolicy(indicators: WorkingIndicator[]) {
  return {
    polling: selectWorkingIndicatorsForKind(indicators, "polling").length > 0,
    marker: selectWorkingIndicatorsForKind(indicators, "marker").length > 0,
  };
}

export function findEditableWorkingIndicator(indicators: WorkingIndicator[]) {
  return selectVisibleWorkingIndicatorsForKind(indicators, "polling").find(
    (indicator) =>
      workingIndicatorPresentation(indicator) === "editable-message",
  );
}

export function workingIndicatorPollIntervalMs(platform: unknown) {
  return (
    PLATFORM_POLL_INTERVAL_MS[safeString(platform).trim().toLowerCase()] ||
    DEFAULT_POLL_INTERVAL_MS
  );
}

export function isWorkingIndicatorPollDue(
  platform: unknown,
  lastPolledAt: number,
  now: number,
) {
  return (
    lastPolledAt <= 0 ||
    now - lastPolledAt >= workingIndicatorPollIntervalMs(platform)
  );
}
