import { formatRuntimeErrorForFrontendDisplay } from "../presentation/error.js";

export type RinFrontendEntrypointStart = () => Promise<unknown> | unknown;

export type RinFrontendEntrypointHost = {
  stderr?: Pick<typeof console, "error">;
  exit?: (code: number) => unknown;
};

export function runFrontendEntrypoint(
  start: RinFrontendEntrypointStart,
  host: RinFrontendEntrypointHost = {},
) {
  const stderr = host.stderr ?? console;
  const exit = host.exit ?? process.exit.bind(process);
  return Promise.resolve()
    .then(start)
    .catch((error: unknown) => {
      stderr.error(formatRuntimeErrorForFrontendDisplay(error));
      exit(1);
    });
}
