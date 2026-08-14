export type ProcessTermination = (exitCode: number) => never;

export class ProcessTerminationRequest extends Error {
  readonly exitCode: number;

  constructor(exitCode: number) {
    super(`rin_process_termination_requested:${exitCode}`);
    if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
      throw new RangeError(
        "Process termination exit code must be an integer from 0 to 255.",
      );
    }
    this.name = "ProcessTerminationRequest";
    this.exitCode = exitCode;
  }
}

export function requestProcessTermination(exitCode: number): never {
  throw new ProcessTerminationRequest(exitCode);
}

export function processTerminationExitCode(error: unknown): number | undefined {
  return error instanceof ProcessTerminationRequest
    ? error.exitCode
    : undefined;
}
