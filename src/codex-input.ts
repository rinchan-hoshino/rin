import type { MessageInput } from './runtime-types.js';
import { randomUUID } from 'node:crypto';
import { CodexAppServer, type AppServerOptions } from './codex-app-server.js';

export type CodexInputOptions = AppServerOptions;

/** All inputs join the same server as App/TUI. No executor or PID ownership. */
export class CodexInput {
  readonly server: CodexAppServer;
  readonly codexHome: string;
  started = false;
  constructor(options: CodexInputOptions = {}) {
    this.server = new CodexAppServer(options);
    this.codexHome = this.server.codexHome;
  }
  async start() { this.server.start(); this.started = true; }
  async stop() { this.started = false; await this.server.stop(); }
  async queue(threadId: string, {text, files = [], onClientMessageId}: MessageInput = {}) {
    if (!this.started) throw new Error('CodexInput not started');
    if (typeof threadId !== 'string' || !threadId.trim()) throw new Error('threadId required');
    if (!Array.isArray(files) || files.some(file => !file || typeof file.path !== 'string' || !file.path.trim())) throw new Error('files must contain path objects');
    const message = typeof text === 'string' ? text.trim() : '';
    if (!message && !files.length) throw new Error('text or files required');
    const images = files.filter(file => file.mimeType?.toLowerCase().startsWith('image/'));
    const attachments = files.filter(file => !images.includes(file));
    const attachmentText = attachments.length ? `\n\nLocal attachments:\n${attachments.map(file => `- ${file.name || 'attachment'}${file.mimeType ? ` (${file.mimeType})` : ''}: ${file.path}`).join('\n')}` : '';
    const input = [
      {type: 'text', text: (message || '附件') + attachmentText, text_elements: []},
      ...images.map(file => ({type: 'localImage', path: file.path})),
    ];
    // Runtime adapters connect only to an operator-managed server. Starting one
    // is reserved for the explicit `rin codex` CLI action.
    await this.server.connect({bootstrap: false});
    // Rejoins an already running task; otherwise loads it from durable history.
    // No model, cwd, instructions or permissions are overridden here.
    await this.server.request('thread/resume', {threadId, excludeTurns: true});
    if (!this.started) throw new Error('CodexInput stopped');
    const messageId = randomUUID();
    onClientMessageId?.(messageId);
    // The server atomically starts or steers the active turn. Avoid a client-side
    // busy-state read/branch race. Never retry an input after sending it.
    const result = await this.server.request<{turn?: {id?: string}}>('turn/start', {threadId, clientUserMessageId: messageId, input});
    if (!result?.turn?.id) throw new Error('app-server returned no turn receipt; outcome uncertain');
    return {threadId, messageId, turnId: result.turn.id, transport: 'app-server'};
  }
}
