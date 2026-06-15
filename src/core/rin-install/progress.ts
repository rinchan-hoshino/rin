import { spinner } from "@clack/prompts";

export function restoreTerminalCursor() {
  if (!process.stderr.isTTY) return;
  try {
    process.stderr.write("\x1B[?25h");
  } catch {}
}

export async function runInstallerProgress<T>(
  message: string,
  action: () => T | Promise<T>,
  options: { successMessage?: string; failureMessage?: string } = {},
): Promise<T> {
  if (!process.stderr.isTTY) return await action();

  const progress = spinner();
  progress.start(message);
  try {
    const result = await action();
    progress.stop(options.successMessage || message);
    return result;
  } catch (error) {
    progress.stop(options.failureMessage || message);
    throw error;
  } finally {
    restoreTerminalCursor();
  }
}
