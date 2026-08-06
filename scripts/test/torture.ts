const DEFAULT_TORTURE_SEED = 20_260_727;
const MAX_TORTURE_SCALE = 10;

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function tortureConfiguration() {
  return {
    seed: positiveInteger(process.env.RIN_TORTURE_SEED, DEFAULT_TORTURE_SEED),
    scale: Math.min(
      positiveInteger(process.env.RIN_TORTURE_SCALE, 1),
      MAX_TORTURE_SCALE,
    ),
  };
}

export function deterministicBits(seed: number, count: number) {
  let state = seed | 0;
  const bits: boolean[] = [];
  for (let index = 0; index < count; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bits.push((state >>> 0) % 2 === 1);
  }
  return bits;
}
