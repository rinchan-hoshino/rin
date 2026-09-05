import { CodexBridge } from './chat/codex.mjs';

function uncertain(reason) {
  const error = new Error(`Codex App ${reason}; outcome uncertain, do not replay automatically`);
  error.code = 'CODEX_APP_UNCERTAIN';
  return error;
}

/** Deliver to the existing App owner and wait for the exact acknowledged turn. */
export class CodexAppExec {
  constructor({ timeoutMs = 1_800_000, bridgeFactory = options => new CodexBridge(options), ...options } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('positive timeoutMs required');
    this.timeoutMs = timeoutMs;
    this.stopped = false;
    this.pending = new Set();
    this.submissions = Promise.resolve();
    this.unsubscribe = null;
    this.threadId = null;
    this.bridge = bridgeFactory({ ...options, appSteering: true, appWake: true, onEvent: event => { for (const pending of [...this.pending]) pending.onEvent(event); } });
  }

  async run(threadId, { text } = {}) {
    if (this.stopped) throw new Error('CodexAppExec stopped');
    if (this.pending.size >= 16) throw new Error('CodexAppExec in-flight limit reached');
    if (this.threadId && this.threadId !== threadId) throw new Error('CodexAppExec supports one session');
    if (typeof threadId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)) throw new Error('existing thread UUID required');
    if (typeof text !== 'string' || !text.trim()) throw new Error('text required');
    this.threadId = threadId;
    return new Promise((resolve, reject) => {
      let settled = false, turnId;
      const observed = new Map();
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(active);
        if (!this.pending.size) { this.unsubscribe?.(); this.unsubscribe = null; }
        if (error) reject(error); else resolve(result);
      };
      const check = () => {
        if (!turnId) return;
        const state = observed.get(turnId);
        if (state?.terminal === 'completed') finish(null, { threadId, turnId, completed: true, text: state.text || '' });
        else if (state?.terminal === 'failed') finish(uncertain('turn failed or was interrupted'));
      };
      const active = {
        cancel: () => finish(uncertain('observer stopped')),
        onEvent: event => {
          if (settled || event.threadId !== threadId) return;
          if (event.type === 'observerError') return finish(uncertain('history observer failed'));
          if (!event.turnId || (turnId && event.turnId !== turnId)) return;
          if (!['completed', 'failed', 'text'].includes(event.type)) return;
          // A turn can finish while IPC is still returning its receipt. Keep a
          // bounded provisional record, then match only the receipt's turn ID.
          if (!observed.has(event.turnId) && observed.size >= 128) return finish(uncertain('observer event limit exceeded'));
          const state = observed.get(event.turnId) || {};
          if (event.type === 'text' && ['final', 'final_answer'].includes(event.phase)) state.text = String(event.text || '').slice(-65536);
          if (['completed', 'failed'].includes(event.type)) state.terminal = event.type;
          observed.set(event.turnId, state);
          check();
        },
      };
      this.pending.add(active);
      const timer = setTimeout(() => finish(uncertain('completion timed out')), this.timeoutMs);
      this.submissions = this.submissions.then(async () => {
        try {
          if (settled || this.stopped) return;
          await this.bridge.start();
          if (settled || this.stopped) return;
          this.unsubscribe ||= this.bridge.watch(threadId);
          if (settled) return;
          const receipt = await this.bridge.queue(threadId, { text });
          if (settled) return;
          if (!receipt?.turnId || !['app-ipc-start', 'app-ipc-steer'].includes(receipt.transport)) {
            finish(uncertain('delivery did not identify an App turn'));
            return;
          }
          turnId = receipt.turnId;
          check();
        } catch { finish(uncertain('delivery or observer failed')); }
      });
    });
  }

  async stop() {
    this.stopped = true;
    for (const pending of [...this.pending]) pending.cancel();
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.bridge.stop();
  }
}
