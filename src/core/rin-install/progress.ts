import { spinner } from "@clack/prompts";

export function restoreTerminalCursor() {
  if (!process.stderr.isTTY) return;
  try {
    process.stderr.write("\x1B[?25h");
  } catch {}
}

function trimProgressMessage(message: string) {
  return message.trim().replace(/[。．.…\s]+$/u, "");
}

function isGenericInstallStepFailure(message: string) {
  return /^(?:Install step failed\.|安装步骤失败。)$/.test(message.trim());
}

export function formatInstallerProgressFailureMessage(
  message: string,
  failureMessage = "",
) {
  if (failureMessage && !isGenericInstallStepFailure(failureMessage)) {
    return failureMessage;
  }
  const step = trimProgressMessage(message).replace(/^正在/u, "");
  if (!step) return failureMessage || message;
  return /[\u3400-\u9fff]/u.test(step) ? `${step}失败。` : `${step} failed.`;
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
    progress.stop(
      formatInstallerProgressFailureMessage(message, options.failureMessage),
    );
    throw error;
  } finally {
    restoreTerminalCursor();
  }
}
