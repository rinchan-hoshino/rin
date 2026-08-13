export function loadFirstValidCandidate<T>(
  filePaths: string[],
  readCandidate: (filePath: string) => unknown,
  normalizeCandidate: (value: unknown, filePath: string) => T | null,
) {
  for (const filePath of filePaths) {
    try {
      const candidate = normalizeCandidate(readCandidate(filePath), filePath);
      if (candidate != null) return candidate;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException)?.code !== "ENOENT" &&
        !(error instanceof SyntaxError)
      ) {
        throw error;
      }
    }
  }
  return null;
}
