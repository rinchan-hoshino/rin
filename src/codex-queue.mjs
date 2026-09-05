import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MAX_COMMAND_OUTPUT = 64 * 1024;

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} required`);
  return value.trim();
}

function stopChild(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode) return resolve();
    const force = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1_000);
    force.unref?.();
    child.once('close', () => { clearTimeout(force); resolve(); });
    child.kill('SIGTERM');
  });
}

function run(command, args, env, { timeoutMs, children }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], [...command.slice(1), ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const append = (current, chunk) => (current + chunk).slice(-MAX_COMMAND_OUTPUT);
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      if (code === 0) return resolve(stdout.trim());
      const detail = stderr.trim().split('\n').at(-1) || `exit ${signal || code}`;
      reject(new Error(`Codex queue failed: ${detail}`));
    });
    const timer = setTimeout(() => {
      void stopChild(child);
      reject(new Error('Codex queue timed out; outcome uncertain'));
    }, timeoutMs);
  });
}

function messageIdFrom(output) {
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  if (!output) return undefined;
  try {
    const value = JSON.parse(output);
    return typeof value?.messageId === 'string' && new RegExp(`^${uuid}$`, 'i').test(value.messageId)
      ? value.messageId : undefined;
  } catch {}
  return output.match(new RegExp(`\\bmessageId\\s*[:=]\\s*(${uuid})\\b`, 'i'))?.[1]
    || output.match(new RegExp(`\\bQueued message\\s+(${uuid})\\b`, 'i'))?.[1];
}

/** Submit to an existing Codex owner through the native queue; never starts an app-server. */
export class CodexQueue {
  constructor({ command = ['codex'], codexHome = join(homedir(), '.codex'), queueTimeoutMs = 30_000 } = {}) {
    if (!Array.isArray(command) || !command.length || command.some(part => typeof part !== 'string' || !part)) {
      throw new Error('command argv required');
    }
    if (!Number.isFinite(queueTimeoutMs) || queueTimeoutMs <= 0) throw new Error('positive queueTimeoutMs required');
    this.command = [...command];
    this.codexHome = codexHome ? requiredText(codexHome, 'codexHome') : undefined;
    this.queueTimeoutMs = queueTimeoutMs;
    this.started = false;
    this.children = new Set();
  }

  async start() { this.started = true; }

  async stop() {
    this.started = false;
    await Promise.all([...this.children].map(stopChild));
  }

  async queue(threadId, { text, files = [] } = {}) {
    if (!this.started) throw new Error('CodexQueue not started');
    const id = requiredText(threadId, 'threadId');
    if (!Array.isArray(files) || files.some(file => !file || typeof file.path !== 'string' || !file.path.trim())) {
      throw new Error('files must contain path objects');
    }
    const message = typeof text === 'string' ? text.trim() : '';
    if (!message && files.length === 0) throw new Error('text or files required');
    const images = files.filter(file => typeof file.mimeType === 'string' && file.mimeType.toLowerCase().startsWith('image/'));
    if (images.length) {
      const error = new Error('Codex queue does not support image attachments; an available App owner is required');
      error.code = 'CODEX_INPUT_UNSUPPORTED';
      throw error;
    }
    const attachments = files.filter(file => !images.includes(file));
    const attachmentText = attachments.length
      ? `\n\nLocal attachments:\n${attachments.map(file => `- ${file.name || 'attachment'}${file.mimeType ? ` (${file.mimeType})` : ''}: ${file.path}`).join('\n')}`
      : '';
    const args = ['queue', '--thread', id, '--message', (message || '附件') + attachmentText];
    for (const file of images) args.push('--image', file.path);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:NERVE_|PI_|RIN_DIR$)/i.test(key)));
    if (this.codexHome) env.CODEX_HOME = this.codexHome;
    const output = await run(this.command, args, env, { timeoutMs: this.queueTimeoutMs, children: this.children });
    const messageId = messageIdFrom(output);
    if (!messageId) throw new Error('Codex queue returned no receipt; outcome uncertain');
    return { threadId: id, messageId };
  }

}
