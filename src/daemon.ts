import {ScriptDirectory} from './nerve-scripts.js';
import {ensureAppServer} from './codex-server-lifecycle.js';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import type {Logger} from './chat/types.js';
interface DaemonDependencies {readChatConfig:typeof readChatConfig; createLogger:typeof createLogger; adapterFactory:typeof adapterFactory; ChatBridge:typeof ChatBridge; CodexBridge:typeof CodexBridge; Nerve:typeof Nerve; Store:typeof Store; makeServer:typeof makeServer; validateNerveConfig:typeof validateNerveConfig; ensureAppServer:typeof ensureAppServer}
interface DaemonOptions extends Partial<DaemonDependencies> {readConfig?:typeof readChatConfig; dependencies?:Partial<DaemonDependencies>; pid?:number; processKill?:typeof process.kill; env?:NodeJS.ProcessEnv; intervalMs?:number; log?:Logger; nerveToken?:string}
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ChatBridge } from './chat/bridge.js';
import { CodexBridge } from './chat/codex.js';
import { Nerve, Store, makeServer, validateConfig as validateNerveConfig } from './nerve.js';
import { adapterFactory, createLogger, readConfig as readChatConfig } from './rin.js';

const defaultLog = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, (message: unknown, ...details: unknown[]) => {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), level, message, details: details.map(value => value instanceof Error ? value.message : value) })}\n`);
}])) as unknown as Logger;

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function resolveConfiguredPath(value: unknown, base: string, name: string) {
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a non-empty path`);
  return isAbsolute(value) ? value : resolve(base, value);
}

function releasePid(pidPath: string | undefined, pid: number) {
  if (!pidPath || !existsSync(pidPath)) return;
  try {
    if (readFileSync(pidPath, 'utf8') === String(pid)) unlinkSync(pidPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function acquireChatPid(dataDir: string, pid: number, processKill: typeof process.kill) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const pidPath = resolve(dataDir, 'bridge.pid');
  if (existsSync(pidPath)) {
    const recorded = Number(readFileSync(pidPath, 'utf8'));
    let live = Number.isSafeInteger(recorded) && recorded > 0;
    if (live) {
      try { processKill(recorded, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') live = false; }
    }
    if (live) throw new Error('Rin bridge already running');
    unlinkSync(pidPath);
  }
  writeFileSync(pidPath, String(pid), { flag: 'wx', mode: 0o600 });
  return pidPath;
}

function closeServer(server?: Server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise<void>((resolveClose, reject) => {
    server.close(error => error ? reject(error) : resolveClose());
    server.closeAllConnections?.();
  });
}

/**
 * Runs the configured chat bridge and Nerve in one process. Relative `database`
 * and `cwd` values in the Nerve file are anchored to that file's directory, so
 * service-manager working directories cannot change their meaning.
 */
export async function startDaemon(configFile: string, options: DaemonOptions = {}) {
  const daemonFile = resolve(configFile);
  const daemonConfig = readJson(daemonFile) as {chat?:string;nerve?:string};
  if (!daemonConfig || typeof daemonConfig !== 'object' || Array.isArray(daemonConfig)) throw new Error('Invalid daemon configuration');
  const daemonDir = dirname(daemonFile);
  const chatFile = daemonConfig.chat == null ? null : resolveConfiguredPath(daemonConfig.chat, daemonDir, 'chat');
  const nerveFile = daemonConfig.nerve == null ? null : resolveConfiguredPath(daemonConfig.nerve, daemonDir, 'nerve');
  if (!chatFile && !nerveFile) throw new Error('No configured work: set chat or nerve in daemon configuration');

  const dependencies: DaemonDependencies = {
    readChatConfig: options.readChatConfig ?? options.readConfig ?? readChatConfig,
    createLogger: options.createLogger ?? createLogger,
    adapterFactory: options.adapterFactory ?? adapterFactory,
    ChatBridge: options.ChatBridge ?? ChatBridge,
    CodexBridge: options.CodexBridge ?? CodexBridge,
    Nerve: options.Nerve ?? Nerve,
    Store: options.Store ?? Store,
    makeServer: options.makeServer ?? makeServer,
    validateNerveConfig: options.validateNerveConfig ?? validateNerveConfig,
    ensureAppServer: options.ensureAppServer ?? ensureAppServer,
    ...options.dependencies,
  };
  const pid = options.pid ?? process.pid;
  const processKill = options.processKill ?? process.kill.bind(process);
  const env = options.env ?? process.env;
  const installFile = resolve(daemonDir, '../install.json');
  const installState = existsSync(installFile) ? readJson(installFile) as {codexHome?:string} : undefined;
  const codexHome = env.CODEX_HOME || installState?.codexHome;
  const defaultCodexOptions = codexHome ? {codexHome} : {};
  const intervalMs = options.intervalMs ?? 1000;
  let chat: ChatBridge | undefined;
  let chatPidPath: string | undefined;
  let nerve: Nerve | undefined;
  let nerveStore: Store | undefined;
  let nerveServer: Server | undefined;
  let nerveScripts:ScriptDirectory | undefined;
  let nerveTimer: NodeJS.Timeout | undefined;
  const nerveTicks = new Set<Promise<void>>();
  let stopping: Promise<void> | undefined;
  let log = options.log ?? defaultLog;

  const tickNerve = () => {
    if (!nerve || nerve.stopping) return Promise.resolve();
    let tick: Promise<void>;
    tick = Promise.resolve().then(() => nerve!.tick()).catch(error => log.error('Nerve tick failed', error)).finally(() => nerveTicks.delete(tick));
    nerveTicks.add(tick);
    return tick;
  };

  const stopNerve = async () => {
    clearInterval(nerveTimer);
    if (nerve) nerve.stopping = true;
    await closeServer(nerveServer);
    await nerveScripts?.stop();
    await nerve?.close();
    await Promise.allSettled([...nerveTicks]);
    nerveStore?.close();
    nerveStore = undefined;
  };

  const stop = () => stopping ||= (async () => {
    try { await chat?.stop(); }
    finally {
      try { releasePid(chatPidPath, pid); }
      finally { await stopNerve(); }
    }
  })();

  try {
    if (nerveFile) {
      const nerveDir = dirname(nerveFile);
      const nerveConfig = readJson(nerveFile);
      dependencies.validateNerveConfig(nerveConfig);
      nerveConfig.database = nerveConfig.database === ':memory:' ? ':memory:' : resolveConfiguredPath(nerveConfig.database, nerveDir, 'database');
      if (nerveConfig.cwd !== undefined) nerveConfig.cwd = resolveConfiguredPath(nerveConfig.cwd, nerveDir, 'cwd');
      if(nerveConfig.scriptsDirectory)nerveConfig.scriptsDirectory=resolveConfiguredPath(nerveConfig.scriptsDirectory,nerveDir,'scriptsDirectory');
      for (const target of Object.values(nerveConfig.targets)) {
        if (target.cwd !== undefined) target.cwd = resolveConfiguredPath(target.cwd, nerveDir, 'target cwd');
      }
      if (!chatFile) await dependencies.ensureAppServer(defaultCodexOptions);
      nerveStore = new dependencies.Store(nerveConfig.database);
      let secrets: Record<string,string> | undefined;
      const secret = (name: string) => env[name] ?? (secrets ??= readJson(resolve(nerveDir, 'secrets.json')) as Record<string,string>)[name];
      nerve = new dependencies.Nerve(nerveConfig, nerveStore);
      const token = options.nerveToken ?? secret('NERVE_TOKEN');
      nerveServer = dependencies.makeServer(nerve, token);
      nerveServer.requestTimeout = 15000;
      await new Promise<void>((resolveListen, reject) => {
        const onError = (error: Error) => { nerveServer!.off('listening', onListen); reject(error); };
        const onListen = () => { nerveServer!.off('error', onError); resolveListen(); };
        nerveServer!.once('error', onError);
        nerveServer!.once('listening', onListen);
        nerveServer!.listen({ port: nerveConfig.port ?? 9761, host: '127.0.0.1', exclusive: true });
      });
      if(nerveConfig.scriptsDirectory){
        nerveScripts=new ScriptDirectory(nerveConfig.scriptsDirectory,{NERVE_ENDPOINT:`http://127.0.0.1:${(nerveServer.address() as AddressInfo).port}`,NERVE_TOKEN:token},(name,error)=>log.error('Producer exited',{name,error}));
        await nerveScripts.start();
      }
      const recovered = nerveStore.recover();
      nerveTimer = setInterval(tickNerve, intervalMs);
      await tickNerve();
      log.info('Nerve ready', { port: (nerveServer.address() as AddressInfo).port, recoveredUncertain: recovered });
    }

    if (chatFile) {
      const chatConfig = dependencies.readChatConfig(chatFile);
      log = options.log ?? dependencies.createLogger(chatConfig);
      // The legacy and combined entrypoints intentionally share this lock.
      // Acquire it before ChatBridge constructs its SQLite store.
      chatPidPath = acquireChatPid(chatConfig.dataDir, pid, processKill);
      const codexOptions = {...defaultCodexOptions, ...chatConfig.codex};
      await dependencies.ensureAppServer(codexOptions);
      const codex = new dependencies.CodexBridge(codexOptions);
      chat = new dependencies.ChatBridge(chatConfig, { codex, adapterFactory: dependencies.adapterFactory, log });
      await chat.start();
      log.info('Rin chat bridge ready');
    }
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    stop,
    chat,
    nerve,
    server: nerveServer,
    address: nerveServer?.address(),
  };
}

export async function main() {
  const [configFile] = process.argv.slice(2);
  if (!configFile) throw new Error('Usage: node src/daemon.mjs CONFIG.json');
  const daemon = await startDaemon(resolve(configFile));
  let signalled: Promise<never> | undefined;
  const stop = () => signalled ||= daemon.stop().then(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
