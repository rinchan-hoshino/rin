import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import {homedir} from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ChatBridge } from './chat/bridge.mjs';
import { CodexBridge } from './chat/codex.mjs';
import { Nerve, Store, makeServer, validateConfig as validateNerveConfig } from './nerve.mjs';
import { adapterFactory, createLogger, readConfig as readChatConfig } from './rin.mjs';
import {runUpdateMigrations} from './install/migrations.mjs';

const defaultLog = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, (message, ...details) => {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), level, message, details: details.map(value => value instanceof Error ? value.message : value) })}\n`);
}]));

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function resolveConfiguredPath(value, base, name) {
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a non-empty path`);
  return isAbsolute(value) ? value : resolve(base, value);
}

function releasePid(pidPath, pid) {
  if (!pidPath || !existsSync(pidPath)) return;
  try {
    if (readFileSync(pidPath, 'utf8') === String(pid)) unlinkSync(pidPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function acquireChatPid(dataDir, pid, processKill) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const pidPath = resolve(dataDir, 'bridge.pid');
  if (existsSync(pidPath)) {
    const recorded = Number(readFileSync(pidPath, 'utf8'));
    let live = Number.isSafeInteger(recorded) && recorded > 0;
    if (live) {
      try { processKill(recorded, 0); }
      catch (error) { if (error.code === 'ESRCH') live = false; }
    }
    if (live) throw new Error('Rin bridge already running');
    unlinkSync(pidPath);
  }
  writeFileSync(pidPath, String(pid), { flag: 'wx', mode: 0o600 });
  return pidPath;
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolveClose, reject) => {
    server.close(error => error ? reject(error) : resolveClose());
    server.closeAllConnections?.();
  });
}

/**
 * Runs the configured chat bridge and Nerve in one process. Relative `database`
 * and `cwd` values in the Nerve file are anchored to that file's directory, so
 * service-manager working directories cannot change their meaning.
 */
export async function startDaemon(configFile, options = {}) {
  const daemonFile = resolve(configFile);
  const daemonConfig = readJson(daemonFile);
  if (!daemonConfig || typeof daemonConfig !== 'object' || Array.isArray(daemonConfig)) throw new Error('Invalid daemon configuration');
  const daemonDir = dirname(daemonFile);
  const chatFile = daemonConfig.chat == null ? null : resolveConfiguredPath(daemonConfig.chat, daemonDir, 'chat');
  const nerveFile = daemonConfig.nerve == null ? null : resolveConfiguredPath(daemonConfig.nerve, daemonDir, 'nerve');
  if (!chatFile && !nerveFile) throw new Error('No configured work: set chat or nerve in daemon configuration');

  const dependencies = {
    readChatConfig: options.readChatConfig ?? options.readConfig ?? readChatConfig,
    createLogger: options.createLogger ?? createLogger,
    adapterFactory: options.adapterFactory ?? adapterFactory,
    ChatBridge: options.ChatBridge ?? ChatBridge,
    CodexBridge: options.CodexBridge ?? CodexBridge,
    Nerve: options.Nerve ?? Nerve,
    Store: options.Store ?? Store,
    makeServer: options.makeServer ?? makeServer,
    validateNerveConfig: options.validateNerveConfig ?? validateNerveConfig,
    ...options.dependencies,
  };
  const pid = options.pid ?? process.pid;
  const processKill = options.processKill ?? process.kill.bind(process);
  const env = options.env ?? process.env;
  const intervalMs = options.intervalMs ?? 1000;
  let chat;
  let chatPidPath;
  let nerve;
  let nerveStore;
  let nerveServer;
  let nerveTimer;
  const nerveTicks = new Set();
  let stopping;
  let log = options.log ?? defaultLog;

  const tickNerve = () => {
    if (!nerve || nerve.stopping) return Promise.resolve();
    let tick;
    tick = Promise.resolve().then(() => nerve.tick()).catch(error => log.error('Nerve tick failed', error)).finally(() => nerveTicks.delete(tick));
    nerveTicks.add(tick);
    return tick;
  };

  const stopNerve = async () => {
    clearInterval(nerveTimer);
    if (nerve) nerve.stopping = true;
    await closeServer(nerveServer);
    await nerve?.close();
    await Promise.allSettled([...nerveTicks]);
    while (nerve?.scanning) await new Promise(resolveWait => setTimeout(resolveWait, 10));
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
      if (nerveConfig.minecraft) nerveConfig.minecraft.stateFile = resolveConfiguredPath(nerveConfig.minecraft.stateFile, nerveDir, 'Minecraft stateFile');
      for (const target of Object.values(nerveConfig.targets)) {
        if (target.cwd !== undefined) target.cwd = resolveConfiguredPath(target.cwd, nerveDir, 'target cwd');
      }
      nerveStore = new dependencies.Store(nerveConfig.database);
      let secrets;
      const secret = name => env[name] ?? (secrets ??= readJson(resolve(nerveDir, 'secrets.json')))[name];
      nerve = new dependencies.Nerve(nerveConfig, nerveStore, {minecraftSecret:nerveConfig.minecraft ? secret(nerveConfig.minecraft.tokenEnv) : undefined});
      const token = options.nerveToken ?? secret('NERVE_TOKEN');
      nerveServer = dependencies.makeServer(nerve, token);
      nerveServer.requestTimeout = 15000;
      await new Promise((resolveListen, reject) => {
        const onError = error => { nerveServer.off('listening', onListen); reject(error); };
        const onListen = () => { nerveServer.off('error', onError); resolveListen(); };
        nerveServer.once('error', onError);
        nerveServer.once('listening', onListen);
        nerveServer.listen({ port: nerveConfig.port ?? 9761, host: '127.0.0.1', exclusive: true });
      });
      await nerve.open?.();
      const recovered = nerveStore.recover();
      nerveTimer = setInterval(tickNerve, intervalMs);
      await tickNerve();
      log.info('Nerve ready', { port: nerveServer.address().port, recoveredUncertain: recovered });
    }

    if (chatFile) {
      const chatConfig = dependencies.readChatConfig(chatFile);
      log = options.log ?? dependencies.createLogger(chatConfig);
      // The legacy and combined entrypoints intentionally share this lock.
      // Acquire it before ChatBridge constructs its SQLite store.
      chatPidPath = acquireChatPid(chatConfig.dataDir, pid, processKill);
      const codex = new dependencies.CodexBridge(chatConfig.codex || {});
      chat = new dependencies.ChatBridge(chatConfig, { codex, adapterFactory: dependencies.adapterFactory, log });
      await chat.start();
      log.info('Rin chat bridge ready');
    }
  } catch (error) {
    await stop();
    throw error;
  }

  let activation={skipped:true};
  if(env.RIN_MANAGED_DAEMON==='1') {
    const migrate=options.runUpdateMigrations ?? runUpdateMigrations;
    try {
      activation=await migrate({
        codexHome:options.codexHome ?? env.CODEX_HOME ?? join(homedir(),'.codex'),
        binary:env.RIN_CODEX_BIN,
        writeConfig:options.writeConfig,
      });
      log.info('Rin managed settings migration complete',activation);
    } catch(error) {
      await stop();
      throw new Error(`Rin managed settings migration failed: ${error.message}`);
    }
  }

  return {
    stop,
    activation:Promise.resolve(activation),
    chat,
    nerve,
    server: nerveServer,
    address: nerveServer?.address(),
  };
}

async function main() {
  const [configFile] = process.argv.slice(2);
  if (!configFile) throw new Error('Usage: node src/daemon.mjs CONFIG.json');
  const daemon = await startDaemon(resolve(configFile));
  let signalled;
  const stop = () => signalled ||= daemon.stop().then(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
