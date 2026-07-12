export type UsageMetrics = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  costTotal: number;
};

type UsageCounts = Pick<
  UsageMetrics,
  "input" | "output" | "cacheRead" | "cacheWrite"
>;

type UsageCosts = Pick<
  UsageMetrics,
  "costInput" | "costOutput" | "costCacheRead" | "costCacheWrite" | "costTotal"
>;

function usageNumber(value: unknown): number {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
}

function usageValue(source: unknown, key: string): unknown {
  if (source == null) return undefined;
  return (source as Record<string, unknown>)[key];
}

function usageField(source: unknown, key: string): number {
  return usageNumber(usageValue(source, key));
}

function readUsageCounts(usage: unknown): UsageCounts {
  return {
    input: usageField(usage, "input"),
    output: usageField(usage, "output"),
    cacheRead: usageField(usage, "cacheRead"),
    cacheWrite: usageField(usage, "cacheWrite"),
  };
}

function readUsageCosts(cost: unknown): UsageCosts {
  return {
    costInput: usageField(cost, "input"),
    costOutput: usageField(cost, "output"),
    costCacheRead: usageField(cost, "cacheRead"),
    costCacheWrite: usageField(cost, "cacheWrite"),
    costTotal: usageField(cost, "total"),
  };
}

function derivedTotalTokens(counts: UsageCounts): number {
  return counts.input + counts.output + counts.cacheRead + counts.cacheWrite;
}

function resolveTotalTokens(usage: unknown, counts: UsageCounts): number {
  return usageField(usage, "totalTokens") || derivedTotalTokens(counts);
}

export function readUsageMetrics(usage: unknown): UsageMetrics {
  const counts = readUsageCounts(usage);
  return {
    ...counts,
    totalTokens: resolveTotalTokens(usage, counts),
    ...readUsageCosts(usageValue(usage, "cost")),
  };
}

export function calculateUsageTotalTokens(usage: unknown): number {
  return readUsageMetrics(usage).totalTokens;
}
