import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MAX_LINE_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function uncertain(reason) {
  const error = new Error(`Codex exec ${reason}; outcome uncertain`);
  error.code = 'CODEX_EXEC_UNCERTAIN';
  return error;
}

/** One bounded resume invocation; preserves the existing thread and configured permissions. */
export class CodexExec {
  constructor({ command = ['codex'], codexHome = join(homedir(), '.codex'), cwd, timeoutMs = 1_800_000 } = {}) {
    if (!Array.isArray(command) || !command.length || command.some(value => typeof value !== 'string' || !value)) throw new Error('command argv required');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('positive timeoutMs required');
    this.command = [...command];
    this.codexHome = codexHome;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.children = new Set();
    this.stopped = false;
  }

  async run(threadId, { text } = {}) {
    if (this.stopped) throw new Error('CodexExec stopped');
    if (typeof threadId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)) throw new Error('existing thread UUID required');
    if (typeof text !== 'string' || !text.trim()) throw new Error('text required');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:NERVE_|PI_|RIN_DIR$)/i.test(key)));
    if (this.codexHome) env.CODEX_HOME = this.codexHome;
    return new Promise((resolve, reject) => {
      const grouped = process.platform !== 'win32';
      const child = spawn(this.command[0], [...this.command.slice(1), 'exec', 'resume', '--json', '--skip-git-repo-check', threadId, '-'], {
        cwd: this.cwd, env, detached: grouped, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let settled = false;
      let line = '';
      let bytes = 0;
      let matchedThread = false;
      let completed = false;
      let finalText = '';
      let killPromise;
      const signal = name => {
        try { if (grouped && child.pid) process.kill(-child.pid, name); else child.kill(name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      };
      const terminate = () => killPromise ||= new Promise(done => {
        signal('SIGTERM');
        // Kill the group even if its leader exits early: descendants may ignore TERM.
        setTimeout(() => { signal('SIGKILL'); done(); }, 1_000);
      });
      const record = { child, terminate, cancel: () => fail('stopped') };
      this.children.add(record);
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.children.delete(record);
        if (error) reject(error); else resolve(result);
      };
      const fail = reason => {
        if (settled) return;
        void terminate().then(() => finish(uncertain(reason)));
      };
      const event = value => {
        if (!value || typeof value.type !== 'string') return fail('invalid JSON event');
        if (value.type === 'thread.started') {
          if (value.thread_id !== threadId) return fail('resumed a different thread');
          matchedThread = true;
        }
        if (value.type === 'turn.started') { completed = false; finalText = ''; }
        if (value.type === 'turn.failed' || value.type === 'error') return fail('reported failure');
        if (value.type === 'turn.completed') {
          if (!matchedThread) return fail('completed without matching thread');
          completed = true;
        }
        if (value.type === 'item.completed' && value.item?.type === 'agent_message' && typeof value.item.text === 'string') {
          if (!value.item.phase || ['final', 'final_answer'].includes(value.item.phase)) finalText = value.item.text;
        }
      };
      const parse = value => {
        if (!value.trim()) return;
        try { event(JSON.parse(value)); } catch { fail('invalid JSON output'); }
      };
      const timer = setTimeout(() => fail('timed out'), this.timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (settled || killPromise) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_OUTPUT_BYTES) return fail('output limit exceeded');
        line += chunk;
        let newline;
        while ((newline = line.indexOf('\n')) !== -1) {
          const current = line.slice(0, newline);
          line = line.slice(newline + 1);
          if (Buffer.byteLength(current) > MAX_LINE_BYTES) return fail('line limit exceeded');
          parse(current);
          if (killPromise) return;
        }
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) fail('line limit exceeded');
      });
      // Drain stderr without retaining or returning potentially sensitive diagnostics.
      child.stderr.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) fail('output limit exceeded');
      });
      child.stdin.on('error', () => fail('input delivery failed'));
      child.once('error', () => fail('could not start'));
      child.once('close', async code => {
        if (killPromise) { await killPromise; return; }
        if (line) parse(line);
        if (killPromise) { await killPromise; return; }
        if (code !== 0 || !matchedThread || !completed) return fail('did not confirm completion');
        finish(null, { threadId, text: finalText, completed: true });
      });
      child.stdin.end(text);
    });
  }

  async stop() {
    this.stopped = true;
    const records = [...this.children];
    for (const record of records) record.cancel();
    await Promise.all(records.map(record => record.terminate()));
  }
}
