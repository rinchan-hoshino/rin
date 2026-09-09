import type {ChatConfig,AdapterConfig,AdapterContext,ChatAdapter,Logger} from './chat/types.js';
import { readFileSync, mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ChatBridge } from './chat/bridge.js';
import { createAgentBridge } from './agents/factory.js';
import { validateConfig } from './chat/policy.js';

export function readConfig(file: string) {
  const config = validateConfig(JSON.parse(readFileSync(file,'utf8')));
  config.dataDir = resolve(dirname(file), config.dataDir || 'chat-data');
  return config;
}
export function createLogger(config: ChatConfig): Logger {
  const secrets = config.adapters.flatMap(a=>[a.token]).filter(Boolean) as string[];
  const scrub = (value: unknown) => {
    let s = value instanceof Error ? value.message : typeof value==='string' ? value : (JSON.stringify(value) ?? String(value));
    for (const secret of secrets) s=s.split(secret).join('[redacted]');
    return s.replace(/bot\d+:[A-Za-z0-9_-]+/g,'bot[redacted]');
  };
  return Object.fromEntries(['debug','info','warn','error'].map(level=>[level,(message:unknown,...rest:unknown[])=>{
    if (level==='debug') return;
    process.stdout.write(JSON.stringify({at:new Date().toISOString(),level,message:scrub(message),details:rest.map(scrub)})+'\n');
  }])) as unknown as Logger;
}
export async function adapterFactory(config: AdapterConfig,context: AdapterContext): Promise<ChatAdapter> {
  const module = await import(`./chat/adapters/${config.type}.js`);
  return module.createAdapter(config,context);
}

export async function serve(file: string) {
  const config = readConfig(file);
  mkdirSync(config.dataDir,{recursive:true,mode:0o700});
  const pidPath = resolve(config.dataDir,'bridge.pid');
  if (existsSync(pidPath)) {
    const pid = Number(readFileSync(pidPath,'utf8'));
    let live = Number.isSafeInteger(pid) && pid > 0;
    if (live) { try { process.kill(pid,0); } catch(error) { if((error as NodeJS.ErrnoException).code==='ESRCH') live=false; } }
    if(live) throw new Error('Rin bridge already running');
    unlinkSync(pidPath);
  }
  writeFileSync(pidPath,String(process.pid),{flag:'wx',mode:0o600});
  const log = createLogger(config);
  const agent = createAgentBridge(config.agent!);
  const bridge = new ChatBridge(config,{agent,adapterFactory,log});
  let stopping: Promise<void> | undefined;
  const stop=()=>stopping ||= bridge.stop().finally(()=>{
    if(existsSync(pidPath) && readFileSync(pidPath,'utf8')===String(process.pid)) unlinkSync(pidPath);
  });
  process.once('SIGTERM',()=>stop().then(()=>process.exit(0)));
  process.once('SIGINT',()=>stop().then(()=>process.exit(0)));
  try { await bridge.start(); log.info('Rin chat bridge ready'); }
  catch(error) { log.error('Rin startup failed',error); await stop(); throw new Error('Rin startup failed; see redacted service log'); }
  return bridge;
}

export function status(file: string) {
  const config=readConfig(file); const pidFile=resolve(config.dataDir,'bridge.pid');
  let running=false; const pid=existsSync(pidFile)?Number(readFileSync(pidFile,'utf8')):null;
  if(pid) { try { process.kill(pid,0);running=true; } catch(error) { if((error as NodeJS.ErrnoException).code==='EPERM')running=true; } }
  const path=resolve(config.dataDir,'chat.sqlite');
  let counts={};
  if(existsSync(path)) {
    const db=new DatabaseSync(path,{readOnly:true});
    counts={inbox:db.prepare('SELECT state,count(*) AS count FROM inbox GROUP BY state').all(),outbox:db.prepare('SELECT state,count(*) AS count FROM deliveries GROUP BY state').all()};db.close();
  }
  return {running,pid,adapters:config.adapters.map(a=>({id:a.id,type:a.type,enabled:a.enabled!==false})),bindings:config.bindings.length,...counts};
}
export async function main() {
  const [command,file]=process.argv.slice(2);
  if(!file || !['serve','status','check'].includes(command)) { console.error('Usage: node src/rin.mjs serve|status|check CONFIG.json'); process.exitCode=2; }
  else if(command==='serve') await serve(resolve(file));
  else if(command==='status') console.log(JSON.stringify(status(resolve(file)),null,2));
  else { readConfig(resolve(file));console.log('Configuration valid'); }
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) await main();
