const PRESETS = Object.freeze({
  en: Object.freeze(['Working...', 'Still working...', 'Making progress...']),
  'zh-CN': Object.freeze(['处理中...', '还在处理...', '正在推进...']),
  ja: Object.freeze(['作業中...', '引き続き作業中...', '進行中...']),
});

export const DEFAULT_WORKING_INTERVAL_MS = 30_000;

export function resolveWorking(config = {}) {
  const input = config && typeof config === 'object' ? config : {};
  const language = Object.hasOwn(PRESETS, input.language) ? input.language : 'en';
  const custom = Array.isArray(input.frames)
    ? input.frames.filter(frame => typeof frame === 'string').map(frame => frame.trim()).filter(Boolean)
    : [];
  const interval = Number(input.intervalMs);
  return {
    frames: custom.length ? custom : [...PRESETS[language]],
    intervalMs: Number.isFinite(interval) && interval >= 100 ? Math.floor(interval) : DEFAULT_WORKING_INTERVAL_MS,
  };
}

export function workingFrame(working, index = 0) {
  const frames = working?.frames?.length ? working.frames : PRESETS.en;
  return frames[((Math.floor(index) || 0) % frames.length + frames.length) % frames.length];
}
