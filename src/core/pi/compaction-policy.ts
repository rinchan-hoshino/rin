export const DEFAULT_RIN_COMPACTION_TRIGGER_PERCENT = 0.85;
export const RIN_COMPACTION_RETAINED_SOURCE_RATIO = 0.2;

export function normalizeRinCompactionTriggerPercent(value: unknown) {
  const percent = Number(value);
  if (!Number.isFinite(percent) || percent <= 0 || percent >= 1) {
    return DEFAULT_RIN_COMPACTION_TRIGGER_PERCENT;
  }
  return percent;
}

export function resolveRinCompactionThresholdTokens(
  contextWindow: number,
  settings: any,
) {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  const triggerPercent = normalizeRinCompactionTriggerPercent(
    settings?.triggerPercent,
  );
  const reserveTokens = Number(settings?.reserveTokens || 0);
  const reserveThreshold =
    reserveTokens > 0 ? contextWindow - reserveTokens : contextWindow;
  return Math.max(
    0,
    Math.floor(Math.min(contextWindow * triggerPercent, reserveThreshold)),
  );
}

export function shouldTriggerRinCompaction(
  contextTokens: number,
  contextWindow: number,
  settings: any,
) {
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) return false;
  const threshold = resolveRinCompactionThresholdTokens(
    contextWindow,
    settings,
  );
  return threshold > 0 && contextTokens >= threshold;
}

export function withRinProportionalCompactionRetention(
  settings: any,
  contextWindow: number,
) {
  const source = settings && typeof settings === "object" ? settings : {};
  const threshold = resolveRinCompactionThresholdTokens(contextWindow, source);
  if (threshold <= 0) return { ...source };
  return {
    ...source,
    keepRecentTokens: Math.max(
      1,
      Math.floor(threshold * RIN_COMPACTION_RETAINED_SOURCE_RATIO),
    ),
  };
}
