const DEFAULT_WORKING_TEXT = 'Working...';

export const DEFAULT_WORKING_INTERVAL_MS = 30_000;

export function resolveWorking(config = {}) {
  const input = config && typeof config === 'object' ? config : {};
  const custom = Array.isArray(input.frames)
    ? input.frames.filter(frame => typeof frame === 'string' && frame.trim())
    : [];
  const text = typeof input.text === 'string' && input.text.trim() ? input.text : '';
  const interval = Number(input.intervalMs);
  return {
    frames: custom.length ? custom : [text || DEFAULT_WORKING_TEXT],
    intervalMs: Number.isFinite(interval) && interval >= 100 ? Math.floor(interval) : DEFAULT_WORKING_INTERVAL_MS,
  };
}

export function workingFrame(working, index = 0) {
  const frames = working?.frames?.length ? working.frames : [DEFAULT_WORKING_TEXT];
  return frames[((Math.floor(index) || 0) % frames.length + frames.length) % frames.length];
}
