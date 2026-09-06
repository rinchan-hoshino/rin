import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startDaemon } from '../src/daemon.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rin-daemon-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name, value) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  return { dir, write };
}

const quietLog = { info() {}, warn() {}, error() {} };

test('combined daemon opens Minecraft with a private token and config-relative state',async t=>{
  const f=fixture(t);
  const nerveFile=f.write('nerve.json',{database:':memory:',port:0,targets:{persona:{type:'codex-app',threadId:'33333333-3333-4333-8333-333333333333'}},minecraft:{endpoint:'http://127.0.0.1:1',stateFile:'state/minecraft.json',tokenEnv:'MINECRAFT_TOKEN',target:'persona',source:{serverId:'test',playerUuid:'11111111-1111-1111-1111-111111111111',maidUuid:'22222222-2222-2222-2222-222222222222'}}});
  const daemon=await startDaemon(f.write('daemon.json',{chat:null,nerve:nerveFile}),{nerveToken:'n'.repeat(32),env:{MINECRAFT_TOKEN:'m'.repeat(32)},log:quietLog,intervalMs:60000});
  t.after(()=>daemon.stop());
  const path=join(f.dir,'state/minecraft.json');
  assert.equal(daemon.nerve.minecraft.path,path);
  assert.ok(existsSync(path));assert.ok(existsSync(`${path}.lock`));
  await daemon.stop();assert.equal(existsSync(`${path}.lock`),false);
});

test('rejects a daemon with no configured work', async t => {
  const f = fixture(t);
  await assert.rejects(startDaemon(f.write('daemon.json', { chat: null, nerve: null })), /No configured work/);
});

test('starts Nerve before chat and stops chat before Nerve', async t => {
  const f = fixture(t);
  const events = [];
  const dataDir = join(f.dir, 'chat-data');
  const chatFile = f.write('chat.json', {});
  const nerveFile = f.write('nerve.json', { database: 'state/events.sqlite', cwd: 'work', targets: { out: { type: 'command', argv: ['true'], cwd: 'target-work' } } });
  const daemonFile = f.write('daemon.json', { chat: chatFile, nerve: nerveFile });
  class FakeStore {
    constructor(path) { this.path = path; events.push('store'); }
    recover() { events.push('recover'); return 0; }
    close() { events.push('store.close'); }
  }
  class FakeNerve {
    constructor(config) { this.config = config; this.running = new Set(); events.push('nerve'); }
    async tick() { events.push('tick'); }
    async close() { events.push('nerve.close'); }
  }
  class FakeServer {
    constructor() { this.listening = false; }
    once(name, fn) { this[name] = fn; }
    off() {}
    listen() { this.listening = true; events.push('listen'); queueMicrotask(() => this.listening()); }
    address() { return { port: 4321 }; }
    close(fn) { this.listening = false; events.push('server.close'); fn(); }
  }
  // Avoid the method/property name collision in a minimal event-emitter fake.
  const makeServer = () => {
    const server = new FakeServer();
    server.listen = function () { this.listening = true; events.push('listen'); queueMicrotask(() => this.listeningHandler()); };
    server.once = function (name, fn) { if (name === 'listening') this.listeningHandler = fn; else this.errorHandler = fn; };
    return server;
  };
  class FakeCodex {}
  class FakeChat {
    async start() { events.push('chat.start'); }
    async stop() { events.push('chat.stop'); }
  }
  const daemon = await startDaemon(daemonFile, { nerveToken: 'x'.repeat(24), log: quietLog, intervalMs: 60_000, dependencies: {
    readChatConfig: () => ({ dataDir, codex: {}, adapters: [], bindings: [] }),
    createLogger: () => quietLog,
    adapterFactory: async () => {},
    ChatBridge: FakeChat,
    CodexBridge: FakeCodex,
    Store: FakeStore,
    Nerve: FakeNerve,
    makeServer,
    validateNerveConfig() {},
  } });
  assert.deepEqual(events.slice(0, 6), ['store', 'nerve', 'listen', 'recover', 'tick', 'chat.start']);
  assert.equal(daemon.nerve.config.database, join(dirname(nerveFile), 'state/events.sqlite'));
  assert.equal(daemon.nerve.config.cwd, join(dirname(nerveFile), 'work'));
  assert.equal(daemon.nerve.config.targets.out.cwd, join(dirname(nerveFile), 'target-work'));
  assert.equal(readFileSync(join(dataDir, 'bridge.pid'), 'utf8'), String(process.pid));
  await daemon.stop();
  assert.ok(events.indexOf('chat.stop') < events.indexOf('nerve.close'));
  assert.equal(existsSync(join(dataDir, 'bridge.pid')), false);
});

test('chat PID lock blocks before bridge construction', async t => {
  const f = fixture(t);
  const dataDir = join(f.dir, 'chat-data');
  const chatFile = f.write('chat.json', {});
  const daemonFile = f.write('daemon.json', { chat: chatFile, nerve: null });
  let constructed = 0;
  const dependencies = {
    readChatConfig: () => ({ dataDir, codex: {}, adapters: [], bindings: [] }),
    createLogger: () => quietLog,
    ChatBridge: class { constructor() { constructed++; } async start() {} async stop() {} },
    CodexBridge: class {},
  };
  const first = await startDaemon(daemonFile, { log: quietLog, dependencies });
  await assert.rejects(startDaemon(daemonFile, { log: quietLog, dependencies }), /already running/);
  assert.equal(constructed, 1);
  await first.stop();
});

test('chat startup failure rolls back an already started Nerve', async t => {
  const f = fixture(t);
  const dataDir = join(f.dir, 'chat-data');
  const chatFile = f.write('chat.json', {});
  const nerveFile = f.write('nerve.json', { database: ':memory:', targets: {} });
  const daemonFile = f.write('daemon.json', { chat: chatFile, nerve: nerveFile });
  const stopped = [];
  class FakeStore { recover() { return 0; } close() { stopped.push('store'); } }
  class FakeNerve { async tick() {} async close() { stopped.push('nerve'); } }
  const server = {
    listening: false,
    once(name, fn) { this[`${name}Handler`] = fn; }, off() {},
    listen() { this.listening = true; queueMicrotask(() => this.listeningHandler()); },
    address() { return { port: 1234 }; },
    close(fn) { this.listening = false; stopped.push('server'); fn(); },
  };
  await assert.rejects(startDaemon(daemonFile, { nerveToken: 'x'.repeat(24), log: quietLog, dependencies: {
    readChatConfig: () => ({ dataDir, codex: {}, adapters: [], bindings: [] }),
    createLogger: () => quietLog,
    ChatBridge: class { async start() { throw new Error('chat failed'); } async stop() { stopped.push('chat'); } },
    CodexBridge: class {}, Store: FakeStore, Nerve: FakeNerve,
    makeServer: () => server, validateNerveConfig() {},
  } }), /chat failed/);
  assert.deepEqual(stopped, ['chat', 'server', 'nerve', 'store']);
  assert.equal(existsSync(join(dataDir, 'bridge.pid')), false);
});

test('empty real Nerve serves health and closes its listener', async t => {
  const f = fixture(t);
  const nerveFile = f.write('nerve.json', { database: 'events.sqlite', cwd: '.', port: 0, targets: {}, triggers: [] });
  const daemonFile = f.write('daemon.json', { chat: null, nerve: nerveFile });
  const token = 'test-daemon-token-at-least-24-characters';
  const daemon = await startDaemon(daemonFile, { nerveToken: token, log: quietLog, intervalMs: 60_000 });
  t.after(()=>daemon.stop());
  const url = `http://127.0.0.1:${daemon.address.port}/health`;
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  assert.deepEqual(await response.json(), { ok: true, targets: [], codexTransport: 'native-exec', minecraft:false, executionCompletionTracked: true });
  await daemon.stop();
  await assert.rejects(fetch(url));
  assert.equal(existsSync(join(f.dir, 'events.sqlite')), true);
});
