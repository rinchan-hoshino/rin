import { spawn } from 'node:child_process';
import { mkdir, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

export interface AppServerOptions {
  command?: string[]; codexHome?: string; endpoint?: string; queueTimeoutMs?: number;
}
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; }

/** A client of the shared server. Closing Rin never stops that server. */
export class CodexAppServer {
  readonly command: string[]; readonly codexHome: string; readonly endpoint: string; readonly timeoutMs: number;
  private socket?: WebSocket;
  private connecting?: Promise<void>;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private stopped = false;
  constructor({command = [process.env.RIN_CODEX_BIN || 'codex'], codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), endpoint = process.platform === 'win32' ? 'ws://127.0.0.1:4500' : 'unix://', queueTimeoutMs = 30_000}: AppServerOptions = {}) {
    if (!Array.isArray(command) || !command.length || command.some(x => typeof x !== 'string' || !x)) throw new Error('command argv required');
    if (typeof codexHome !== 'string' || !codexHome.trim()) throw new Error('codexHome required');
    if (!Number.isFinite(queueTimeoutMs) || queueTimeoutMs <= 0) throw new Error('positive queueTimeoutMs required');
    if (typeof endpoint !== 'string' || !/^(unix:\/\/|wss?:\/\/)/.test(endpoint)) throw new Error('app-server endpoint must be unix://, ws:// or wss://');
    this.command = [...command]; this.codexHome = codexHome; this.endpoint = endpoint; this.timeoutMs = queueTimeoutMs;
  }
  start() { this.stopped = false; }
  async connect({bootstrap = true}: {bootstrap?: boolean} = {}) {
    if (this.stopped) throw new Error('app-server client stopped');
    if (this.connecting) return this.connecting;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    this.connecting = this.open(bootstrap).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async open(bootstrap: boolean) {
    try { await this.openSocket(); }
    catch (error) {
      // Only absence of the default local listener allows bootstrap. A custom
      // endpoint, auth rejection or broken handshake must not start another host.
      const defaultEndpoint = process.platform === 'win32' ? 'ws://127.0.0.1:4500' : 'unix://';
      if (!bootstrap || this.endpoint !== defaultEndpoint || !['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
      if (this.stopped) throw new Error('app-server client stopped');
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:NERVE_|PI_|RIN_DIR$|RIN_MANAGED_DAEMON$)/i.test(key)));
      env.CODEX_HOME = this.codexHome;
      const directory = join(this.codexHome, 'app-server-control');
      await mkdir(directory, {recursive: true, mode: 0o700});
      const log = await open(join(directory, 'rin-start.log'), 'a', 0o600);
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(this.command[0], [...this.command.slice(1), 'app-server', '--listen', this.endpoint], {
            env, detached: true, stdio: ['ignore', log.fd, log.fd], windowsHide: true,
          });
          child.once('error', reject);
          child.once('spawn', () => { child.unref(); resolve(); });
        });
      } finally { await log.close(); }
      // Codex owns socket exclusivity. Concurrent starters can lose the bind
      // race safely; each client connects to the winner, without a PID ledger.
      const deadline = Date.now() + this.timeoutMs;
      while (true) {
        if (this.stopped) throw new Error('app-server client stopped');
        try { await this.openSocket(); break; }
        catch (cause) {
          if (!['ENOENT', 'ECONNREFUSED'].includes((cause as NodeJS.ErrnoException).code || '')) throw cause;
          if (Date.now() >= deadline) throw new Error(`app-server did not become ready; see ${join(directory, 'rin-start.log')}`);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }
    try {
      const result = await this.request<{codexHome?: string}>('initialize', {
        clientInfo: {name: 'rin', version: '1'},
        capabilities: {experimentalApi: true, requestAttestation: false},
      });
      if (result.codexHome && await realpath(result.codexHome) !== await realpath(this.codexHome)) throw new Error('Shared app-server uses a different CODEX_HOME');
      this.socket!.send(JSON.stringify({method: 'initialized'}));
    } catch (error) { this.socket?.terminate(); throw error; }
  }
  private openSocket() {
    if (this.stopped) return Promise.reject(new Error('app-server client stopped'));
    return new Promise<void>((resolve, reject) => {
      const unix = this.endpoint.startsWith('unix://');
      const path = this.endpoint.slice('unix://'.length) || join(this.codexHome, 'app-server-control', 'app-server-control.sock');
      const socket = new WebSocket(unix ? `ws+unix://${path}:/rpc` : this.endpoint, {
        ...(unix ? {headers: {Host: 'localhost'}} : {}), perMessageDeflate: false,
        handshakeTimeout: this.timeoutMs, maxPayload: 16 * 1024 * 1024,
      });
      this.socket = socket;
      socket.once('open', resolve);
      socket.on('error', reject);
      socket.on('close', () => {
        reject(new Error('app-server connection closed'));
        if (this.socket !== socket) return;
        this.socket = undefined;
        for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('app-server connection closed; outcome uncertain')); }
        this.pending.clear();
      });
      socket.on('message', raw => {
        let message: {id?: number; method?: string; result?: unknown; error?: {code?: number; message?: string}};
        try { message = JSON.parse(String(raw)); } catch { socket.terminate(); return; }
        // Server requests (including human approvals) belong to an interactive
        // client. Rin does not auto-approve or reject them on the user's behalf.
        if (!message || message.method || typeof message.id !== 'number') return;
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id); clearTimeout(entry.timer);
        if (message.error) entry.reject(Object.assign(new Error(message.error.message || 'app-server request rejected'), {rpcCode: message.error.code}));
        else entry.resolve(message.result);
      });
    });
  }
  request<T = unknown>(method: string, params: unknown): Promise<T> {
    const socket = this.socket;
    if (this.stopped || socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('app-server not connected'));
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server ${method} timed out; outcome uncertain`));
        socket.terminate();
      }, this.timeoutMs);
      this.pending.set(id, {resolve: value => resolve(value as T), reject, timer});
      socket.send(JSON.stringify({id, method, params}), error => {
        if (!error) return;
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
    });
  }
  async stop() {
    this.stopped = true;
    const socket = this.socket;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>(resolve => { socket.once('close', resolve); socket.terminate(); });
    }
  }
}
