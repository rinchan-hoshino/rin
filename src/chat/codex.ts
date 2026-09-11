import type { CodexEvent } from './types.js';
interface Watcher {stop(): void; unsubscribe(): void;}
interface BridgeOptions extends CodexInputOptions {onEvent?: (event: CodexEvent) => void; getCursor?: (key: string) => unknown; setCursor?: (key: string, value: unknown) => void; pollMs?: number;}
import { CodexInput, type CodexInputOptions } from '../codex-input.js';
import { createCodexThread } from './codex-thread-create.js';
import {observeCodexHistory} from './codex-history.js';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

function requiredText(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} required`);
  return value.trim();
}

/** Shared app-server input with a durable, read-only chat delivery observer. */
export class CodexBridge extends CodexInput {
  onEvent: (event: CodexEvent) => void; getCursor?: (key: string) => unknown; setCursor?: (key: string, value: unknown) => void; pollMs: number; watchers: Map<string, Watcher>;
  constructor({ command = ['codex'], codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), onEvent = () => {}, getCursor, setCursor, pollMs = 500, queueTimeoutMs = 30_000, endpoint }: BridgeOptions = {}) {
    super({ command, codexHome, queueTimeoutMs, endpoint });
    if (typeof onEvent !== 'function') throw new Error('onEvent function required');
    if (!Number.isFinite(pollMs) || pollMs < 10) throw new Error('pollMs must be at least 10');
    this.onEvent = onEvent;
    this.getCursor = getCursor;
    this.setCursor = setCursor;
    this.pollMs = pollMs;
    this.watchers = new Map();

  }
  attachmentRoots(threadId: string) { return [join(this.codexHome!, 'generated_images', threadId)]; }

  async createThread({ cwd, model, name }: {cwd?: string; model?: string; name?: string} = {}) {
    if (!this.started) throw new Error('CodexBridge not started');
    const directory = resolve(requiredText(cwd, 'cwd'));
    const selectedModel = model === undefined ? undefined : requiredText(model, 'model');
    const title = name === undefined ? undefined : requiredText(name, 'name');
    return createCodexThread({ server: this.server, cwd: directory, model: selectedModel, name: title });
  }

  async stop() {
    for (const watcher of this.watchers.values()) watcher.stop();
    this.watchers.clear();
    await super.stop();
  }

  async watch(threadId: string) {
    const id=requiredText(threadId,'threadId');
    if(!this.started)throw new Error('CodexBridge not started');
    if(this.watchers.has(id))return this.watchers.get(id)!.unsubscribe;
    const stop=await observeCodexHistory({server:this.server,threadId:id,pollMs:this.pollMs,
      emit:event=>this.onEvent(event),getCursor:this.getCursor,setCursor:this.setCursor});
    if(!this.started){stop();throw new Error('CodexBridge stopped');}
    const watcher:Watcher={stop,unsubscribe:()=>{if(this.watchers.get(id)===watcher){this.watchers.delete(id);stop();}}};
    this.watchers.set(id,watcher);return watcher.unsubscribe;
  }
}
