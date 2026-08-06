import fc, {
  type IAsyncProperty,
  type IProperty,
  type Parameters,
} from "fast-check";

const DEFAULT_PROPERTY_SEED = 20_260_727;
const DEFAULT_PROPERTY_RUNS = 200;

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function propertyParameters(
  overrides: Parameters<unknown> = {},
): Parameters<unknown> {
  return {
    seed: positiveInteger(process.env.RIN_PROPERTY_SEED, DEFAULT_PROPERTY_SEED),
    numRuns: positiveInteger(
      process.env.RIN_PROPERTY_RUNS,
      DEFAULT_PROPERTY_RUNS,
    ),
    endOnFailure: true,
    verbose: 1,
    ...overrides,
  };
}

export function assertProperty<Ts>(
  property: IProperty<Ts>,
  overrides: Parameters<Ts> = {},
) {
  fc.assert(property, propertyParameters(overrides) as Parameters<Ts>);
}

export async function assertAsyncProperty<Ts>(
  property: IAsyncProperty<Ts>,
  overrides: Parameters<Ts> = {},
) {
  await fc.assert(property, propertyParameters(overrides) as Parameters<Ts>);
}

export { fc };
