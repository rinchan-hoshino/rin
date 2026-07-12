export const FORWARDED_CHILD_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export function signalExitCode(signal: NodeJS.Signals) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  if (signal === "SIGHUP") return 129;
  return 1;
}

type SignalEmitter = {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
};

type SignalChild = {
  killed?: boolean;
  kill(signal: NodeJS.Signals): unknown;
};

export function forwardChildSignals(
  child: SignalChild,
  options: {
    emitter?: SignalEmitter;
    beforeForward?: (signal: NodeJS.Signals) => void;
  } = {},
) {
  const emitter = options.emitter || process;
  const handlers = new Map<NodeJS.Signals, () => void>();
  let forwardedSignal: NodeJS.Signals | null = null;

  for (const signal of FORWARDED_CHILD_SIGNALS) {
    const handler = () => {
      forwardedSignal = signal;
      options.beforeForward?.(signal);
      if (!child.killed) child.kill(signal);
    };
    handlers.set(signal, handler);
    emitter.once(signal, handler);
  }

  return {
    get forwardedSignal() {
      return forwardedSignal;
    },
    cleanup() {
      for (const [signal, handler] of handlers) emitter.off(signal, handler);
      handlers.clear();
    },
  };
}
