export type TuiStartupTerminal = {
  isTTY?: boolean;
  write?(value: string): unknown;
};

export type TuiStartupStatusAnimation = {
  stop(): void;
};

const STARTING_STATUS_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];
const STARTING_STATUS_INTERVAL_MS = 80;

export function startTuiStartupStatusAnimation(
  stdout: TuiStartupTerminal = process.stdout,
  options: { intervalMs?: number } = {},
): TuiStartupStatusAnimation {
  if (!stdout.isTTY || typeof stdout.write !== "function") {
    return { stop() {} };
  }

  let frameIndex = 0;
  let stopped = false;
  const intervalMs = Math.max(
    1,
    options.intervalMs ?? STARTING_STATUS_INTERVAL_MS,
  );
  const render = () => {
    const frame =
      STARTING_STATUS_FRAMES[frameIndex] ?? STARTING_STATUS_FRAMES[0];
    frameIndex = (frameIndex + 1) % STARTING_STATUS_FRAMES.length;
    stdout.write?.(`\r\x1b[K${frame} Starting...`);
  };
  render();
  const timer = setInterval(render, intervalMs);
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      stdout.write?.("\r\x1b[K");
    },
  };
}
