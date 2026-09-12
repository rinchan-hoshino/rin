import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {CodexAppServer, type AppServerOptions} from './codex-app-server.js';

const execute = promisify(execFile);
interface StartDependencies {
  start?: (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<void>;
  platform?: NodeJS.Platform;
}
const start = async (command: string, args: string[], env: NodeJS.ProcessEnv) => {
  await execute(command, args, {env, timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true});
};
export async function ensureAppServer(options: AppServerOptions = {}, dependencies: StartDependencies = {}) {
  const client = new CodexAppServer(options);
  const platform = dependencies.platform ?? process.platform;
  const defaultEndpoint = platform === 'win32' ? 'ws://127.0.0.1:4500' : 'unix://';
  if (client.endpoint !== defaultEndpoint) throw new Error('Rin starts Codex only at the default local app-server endpoint. Start remote or custom endpoints at their host.');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:NERVE_|PI_|RIN_DIR$|RIN_MANAGED_DAEMON$)/i.test(key)));
  env.CODEX_HOME = client.codexHome;
  try {
    await (dependencies.start ?? start)(client.command[0], [...client.command.slice(1), 'app-server', 'daemon', 'start'], env);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Codex app-server daemon start failed. The configured Codex executable must support this command: ${detail}`);
  }
  try { await client.connect(); }
  finally { await client.stop(); }
}

interface ProcessInfo {pid: number; parent: number; uid: number; command: string; started?: string}
interface RestartDependencies {
  run?: (command: string, args: string[]) => Promise<string>;
  kill?: (pid: number, signal: NodeJS.Signals | 0) => boolean;
  platform?: NodeJS.Platform;
  pid?: number;
  uid?: number;
  ensure?: typeof ensureAppServer;
}
const run = async (command: string, args: string[]) => (await execute(command, args, {timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true})).stdout;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const isCodexServer = (command: string) => /(?:^|[\\/\s])codex(?:\.exe)?["']?(?:\s|$)/.test(command) && /(?:^|\s)["']?app-server["']?(?:\s|$)/.test(command) && !/\bapp-server["']?\s+["']?(?:proxy|daemon|generate-|help)/.test(command);

/** Inspect the exact local listener before the caller stops Rin. No PID file or supervisor. */
export async function prepareAppServerStop(options: AppServerOptions = {}, dependencies: RestartDependencies = {}) {
  const exec = dependencies.run ?? run;
  const signal = dependencies.kill ?? process.kill.bind(process);
  const platform = dependencies.platform ?? process.platform;
  const ownPid = dependencies.pid ?? process.pid;
  const ownUid = dependencies.uid ?? process.getuid?.();
  const client = new CodexAppServer(options);
  const endpoint = client.endpoint;
  if (endpoint !== (platform === 'win32' ? 'ws://127.0.0.1:4500' : 'unix://')) {
    throw new Error('App-server stop/restart requires the default local endpoint. Restart custom servers at their host.');
  }
  // Never start a missing server merely to stop it. The handshake verifies its
  // protocol and CODEX_HOME before any process inspection or signal.
  try { await client.connect(); }
  catch (error) {
    if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code || '')) return async () => {};
    throw error;
  } finally { await client.stop(); }
  const socketPath = resolve(endpoint.slice('unix://'.length) || join(client.codexHome, 'app-server-control/app-server-control.sock'));
  const canonicalPath = platform === 'win32' ? '' : await realpath(socketPath);
  async function inspect(): Promise<{target: ProcessInfo; processes: ProcessInfo[]}> {
    if (platform === 'win32') {
      const script = "$ErrorActionPreference='Stop';$identity=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;" +
        "$listeners=@(Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort 4500 -ErrorAction SilentlyContinue);" +
        "$rows=@(Get-CimInstance Win32_Process | ForEach-Object {$p=$_;$owned=0;if($p.ProcessId -in $listeners.OwningProcess){$owner=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction SilentlyContinue;if($owner.Sid -eq $identity){$owned=1}};" +
        "[pscustomobject]@{pid=[int]$p.ProcessId;parent=[int]$p.ParentProcessId;uid=$owned;command=[string]$p.CommandLine;started=[string]$p.CreationDate}});" +
        "@{listeners=@($listeners|Select-Object -ExpandProperty OwningProcess -Unique);processes=$rows}|ConvertTo-Json -Depth 4 -Compress";
      const value = JSON.parse(await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]));
      const processes = value.processes as ProcessInfo[];
      const candidates = processes.filter(p => value.listeners.includes(p.pid) && p.uid === 1 && isCodexServer(p.command));
      if (candidates.length !== 1) throw new Error('Cannot uniquely identify the current user\'s Codex app-server listener; no process was stopped.');
      return {target: candidates[0], processes};
    }
    const processes = (await exec('ps', ['-axo', 'pid=,ppid=,uid=,args='])).split('\n').flatMap(line => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      return match ? [{pid: Number(match[1]), parent: Number(match[2]), uid: Number(match[3]), command: match[4]}] : [];
    });
    const candidates = processes.filter(p => p.uid === ownUid && isCodexServer(p.command));
    if (!candidates.length) throw new Error('No local Codex app-server process owns this connection; no process was stopped.');
    const owners = new Set<number>();
    if (platform === 'darwin') {
      // Kernel socket tables avoid walking unrelated open files or mounted
      // network volumes. SO_ACCEPTCONN (0x2) distinguishes listening sockets.
      const lines = (await exec('netstat', ['-anv', '-f', 'unix'])).split('\n');
      const header = lines.find(line=>line.trim().startsWith('Address '))?.trim().split(/\s+/) ?? [];
      const processColumn=header.indexOf('process:pid'),optionsColumn=header.indexOf('options');
      if (processColumn<0 || optionsColumn<0) throw new Error('Unrecognized macOS socket table; no process was stopped.');
      for (const line of lines) {
        if (![socketPath,canonicalPath].some(path=>line.endsWith(` ${path}`))) continue;
        const fields=line.trim().split(/\s+/);
        const match=fields[processColumn]?.match(/:(\d+)$/);
        if (match && (parseInt(fields[optionsColumn],16)&2)) owners.add(Number(match[1]));
      }
    } else {
      const output=await exec('ss',['-xlpnH']);
      const escape=(path:string)=>path.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const address=new RegExp(`\\s(?:${escape(socketPath)}|${escape(canonicalPath)})\\s+\\d+\\s`);
      for(const line of output.split('\n')) {
        if(!address.test(line))continue;
        for(const match of line.matchAll(/\bpid=(\d+)\b/g))owners.add(Number(match[1]));
      }
    }
    const matches = candidates.filter(p => owners.has(p.pid));
    if (matches.length !== 1) throw new Error('Cannot uniquely identify the Codex process owning the Unix socket; no process was stopped.');
    const target={...matches[0],started:(await exec('ps',['-p',String(matches[0].pid),'-o','lstart='])).trim()};
    if(!target.started)throw new Error('App-server exited during process inspection; no process was stopped.');
    return {target, processes};
  }
  const before = await inspect();
  const parents = new Map(before.processes.map(p => [p.pid, p.parent]));
  for (let pid = ownPid, seen = new Set<number>(); pid && !seen.has(pid); pid = parents.get(pid) ?? 0) {
    if (pid === before.target.pid) throw new Error('Run rin codex stop/restart from a separate terminal outside this app-server; it is executing the current task.');
    seen.add(pid);
  }
  return async () => {
    const current = await inspect();
    if (current.target.pid !== before.target.pid || current.target.command !== before.target.command || current.target.started !== before.target.started) {
      throw new Error('App-server changed while preparing restart; no process was stopped. Retry from a separate terminal.');
    }
    signal(current.target.pid, 'SIGTERM');
    const deadline = Date.now() + client.timeoutMs;
    while (true) {
      try { signal(current.target.pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') break; throw error; }
      if (Date.now() >= deadline) throw new Error('App-server did not exit after SIGTERM. No force kill was attempted; The server was not restarted.');
      await delay(100);
    }
  };
}

/** Restart reuses the same verified stop operation, then starts one listener. */
export async function prepareAppServerRestart(options: AppServerOptions = {}, dependencies: RestartDependencies = {}) {
  const stop = await prepareAppServerStop(options, dependencies);
  return async () => { await stop(); await (dependencies.ensure ?? ensureAppServer)(options); };
}
