// Standard API USD-equivalent snapshot, verified 2026-09-07. This is an
// estimate of token value, not a Codex subscription charge or quota conversion.
export const CODEX_PRICING = Object.freeze({
  checkedAt: '2026-09-07',
  source: 'https://developers.openai.com/api/docs/pricing',
  tierInputThreshold: 272000,
  models: {
    // [uncached input, cached input, cache write, output] USD / 1M tokens.
    'gpt-6-astra': [[10, 1, 12.5, 50], [20, 2, 25, 75]],
    'gpt-5.6-sol': [[4, 0.4, 5, 20], [8, 0.8, 10, 30]],
    'gpt-5.6-terra': [[2, 0.2, 2.5, 12], [4, 0.4, 5, 18]],
    'gpt-5.6-luna': [[0.2, 0.02, 0.25, 1.2], [0.4, 0.04, 0.5, 1.8]],
  },
});

export function estimateCodexUsageCost(record, model) {
  const tiers = CODEX_PRICING.models[model];
  // Nonzero write counters have not been observed in the Codex rollout
  // schema. Avoid assuming whether they overlap input until documented.
  if (!tiers || record.cache_write > 0) return null;
  const rates = tiers[record.input + record.cached > CODEX_PRICING.tierInputThreshold ? 1 : 0];
  return (record.input * rates[0] + record.cached * rates[1] + record.output * rates[3]) / 1_000_000;
}
