export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`parallel_concurrency_invalid:${concurrency}`);
  }
  if (values.length === 0) return [];

  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let firstError: unknown;
  let failed = false;

  const runWorker = async () => {
    while (!failed) {
      const index = nextIndex;
      if (index >= values.length) return;
      nextIndex += 1;
      try {
        results[index] = await worker(values[index] as T, index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, runWorker),
  );
  if (failed) throw firstError;
  return results;
}
