import {errorCode} from './types.js';
import type {Exec,Executable,JsonValue} from './types.js';
import type {ConfigWriter,ConfigEdit} from './profile.js';
import type {AddressInfo} from 'node:net';
import {randomBytes} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {createServer} from 'node:net';
import {atomicJSON,codexCommand,run as coreRun} from './core.js';
import {createCodexConfigWriter} from './profile.js';
import {validateConfig} from '../nerve-config.js';

async function readOptional<T = Record<string,unknown>>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file,'utf8')); }
  catch(error) { if(errorCode(error)==='ENOENT')return undefined;throw error; }
}
function object<T extends object = Record<string,unknown>>(value: unknown,name: string): T {
  if(!value || typeof value!=='object' || Array.isArray(value))throw new Error(`Invalid ${name}`);
  return value as T;
}
async function availablePort() {
  const server=createServer();
  await new Promise<void>((accept,reject)=>{server.once('error',reject);server.listen({host:'127.0.0.1',port:0,exclusive:true},accept);});
  const port=(server.address() as AddressInfo).port;
  await new Promise<void>((accept,reject)=>server.close(error=>error?reject(error):accept()));
  return port;
}

/** Register only Rin-owned Nerve entries; initialize an idle service without a persona. */
export async function ensureNerveMcp({home,codexHome,node=process.execPath,binary,command,run=coreRun,writeConfig}: NerveMcpOptions={}): Promise<NerveMcpResult> {
  if(!home || !codexHome)throw new TypeError('home and codexHome are required');
  home=resolve(home);codexHome=resolve(codexHome);
  const env={...process.env,CODEX_HOME:codexHome};
  const executable=typeof command==='string'?{command,args:[]}:command || await codexCommand({binary,env});
  const cwd=await mkdtemp(join(tmpdir(),'rin-nerve-config-'));
  let inspection;
  try { inspection=await run(executable.command,[...(executable.args || []),'mcp','get','nerve','--json'],{cwd,env,capture:true,allowFailure:true}); }
  finally { await rm(cwd,{recursive:true,force:true}); }
  let current: McpEntry | undefined;
  if(inspection.code===0)current=object<McpEntry>(JSON.parse(inspection.stdout),'Nerve MCP entry');
  else if(!/No MCP server named .* found/i.test(`${inspection.stdout || ''}\n${inspection.stderr || ''}`))throw new Error('Could not inspect existing Nerve MCP configuration');
  const privateDir=join(home,'private'),daemonPath=join(privateDir,'daemon.json');
  const daemon=object<{chat?: string|null; nerve?: string|null}>(await readOptional(daemonPath) ?? {chat:null,nerve:null},'daemon configuration');
  if(daemon.nerve!=null && (typeof daemon.nerve!=='string' || !daemon.nerve))throw new Error('Invalid daemon Nerve path');
  const daemonNerve=daemon.nerve==null?null:resolve(privateDir,daemon.nerve);
  const transport=current?.transport || current;
  const configuredEnv=transport?.env ?? current?.env ?? {};
  object(configuredEnv,'Nerve MCP environment');
  const envPath=configuredEnv.NERVE_CONFIG;
  if(envPath!==undefined && (typeof envPath!=='string' || !isAbsolute(envPath)))throw new Error('NERVE_CONFIG must be an absolute path');
  if(daemonNerve && envPath && resolve(envPath)!==daemonNerve)throw new Error('Nerve MCP and daemon configuration paths conflict');
  const stable=join(home,'nerve-mcp-run.mjs');
  if(current) {
    const args=transport?.args;
    const script=Array.isArray(args) && args.length===1 && typeof args[0]==='string' && isAbsolute(args[0])?resolve(args[0]):null;
    const releasePath=script?relative(home,script).split('\\').join('/'):'';
    const owned=script===stable || /^releases\/[a-f0-9]{40}\/src\/nerve-mcp\.mjs$/.test(releasePath);
    const linked=script && basename(script)==='nerve-mcp.mjs' && daemonNerve && envPath && resolve(envPath)===daemonNerve;
    if(!owned && !linked)throw new Error('An unrelated nerve MCP entry already exists; its configuration was preserved');
  }
  const configPath=daemonNerve || (envPath && resolve(envPath)) || join(privateDir,'nerve.json');
  const pendingPath=join(privateDir,'nerve-setup-pending.json');
  const pending=await readOptional(pendingPath);
  if(pending && pending.configPath!==configPath)throw new Error('Pending Nerve activation points to a different configuration');
  let config=await readOptional(configPath);
  const initialized=config===undefined;
  if(initialized && (daemonNerve || envPath))throw new Error('Configured Nerve file is missing; refusing to replace it');
  if(initialized)config={database:'nerve.sqlite',port:await availablePort(),targets:{}};
  config=object(config,'Nerve configuration');
  object(config.targets,'Nerve targets');
  // Older fresh installs wrote an empty producer list. It has no behavior to
  // migrate; nonempty lists still need an explicit producer migration.
  const emptyLegacyTriggers=Array.isArray(config.triggers) && config.triggers.length===0;
  if(emptyLegacyTriggers) { config={...config};delete config.triggers; }
  else if('triggers' in config)throw new Error(`Nerve configuration ${configPath} contains legacy triggers. Migrate these tasks to producer scripts before upgrading; the configuration was preserved.`);
  validateConfig(config);
  if(typeof config.database!=='string' || !config.database)throw new Error('Nerve database path is required');
  if(config.port!==undefined && (typeof config.port!=='number' || !Number.isInteger(config.port) || config.port<1 || config.port>65535))throw new Error('Invalid Nerve port');
  const secretsPath=join(dirname(configPath),'secrets.json');
  const previousSecrets=await readOptional(secretsPath);
  const secrets=object(previousSecrets ?? {},'Nerve secrets');
  let secretsChanged=false;
  if(secrets.NERVE_TOKEN===undefined && initialized) { secrets.NERVE_TOKEN=randomBytes(32).toString('hex');secretsChanged=true; }
  if(typeof secrets.NERVE_TOKEN!=='string' || secrets.NERVE_TOKEN.length<24)throw new Error('Existing Nerve configuration requires a valid NERVE_TOKEN in secrets.json');
  const edits: ConfigEdit[]=[];
  const edit=(key: string,value: JsonValue)=>edits.push({keyPath:`mcp_servers.nerve.${key}`,value,mergeStrategy:'upsert'});
  if(transport?.command!==node)edit('command',node);
  if(JSON.stringify(transport?.args)!==JSON.stringify([stable]))edit('args',[stable]);
  if(envPath!==configPath)edit('env.NERVE_CONFIG',configPath);
  if(!current)edit('enabled',true);
  const writer=writeConfig || createCodexConfigWriter({command:executable,codexHome});
  await mkdir(dirname(configPath),{recursive:true,mode:0o700});
  await mkdir(privateDir,{recursive:true,mode:0o700});
  if(secretsChanged)await atomicJSON(secretsPath,secrets);
  if(initialized || emptyLegacyTriggers)await atomicJSON(configPath,config);
  // Failure never attaches a newly initialized service to the daemon. Keep its
  // valid private files for retry because a failed RPC can have committed edits.
  if(edits.length)await writer({edits,reloadUserConfig:true});
  const daemonChanged=!daemonNerve;
  if(daemonChanged) {
    await atomicJSON(pendingPath,{configPath});
    await atomicJSON(daemonPath,{...daemon,nerve:configPath});
  }
  return {initialized,daemonChanged,registered:edits.length>0,configPath,needsActivation:current?.enabled!==false && Boolean(daemonChanged || pending)};
}

interface McpTransport {command?: string;args?: string[];env?: Record<string,string>}
interface McpEntry extends McpTransport {transport?: McpTransport;enabled?: boolean}
export interface NerveMcpOptions {home?: string;codexHome?: string;node?: string;binary?: string;command?: string|Executable;run?: Exec;writeConfig?: ConfigWriter}
export interface NerveMcpResult {initialized: boolean;daemonChanged: boolean;registered: boolean;configPath: string;needsActivation: boolean}
