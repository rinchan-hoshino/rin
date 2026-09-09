import {errorCode} from './types.js';
import type {Exec,ExecOptions,ExecResult,Service} from './types.js';
export interface ServiceOptions {home: string; node?: string; platform?: NodeJS.Platform; userHome?: string; env?: NodeJS.ProcessEnv; run?: Exec; isReady?: ()=>Promise<boolean>; timeoutMs?: number; pollMs?: number; serviceId?: string}
interface ServiceCommand {node: string; runner: string; pathValue: string}
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';
import {run as coreRun,exists} from './core.js';

const MAC_LABEL='com.rin.service';
const LINUX_UNIT='rin.service';
const WINDOWS_TASK='Rin';

const xml= (value: unknown)=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const systemd= (value: unknown)=>String(value).replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%').replaceAll('$',()=> '$$').replaceAll('\n','\\n');
const ps= (value: unknown)=>`'${String(value).replaceAll("'","''")}'`;

function macPlist({node,runner,pathValue}: ServiceCommand, label=MAC_LABEL) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(runner)}</string></array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(pathValue)}</string></dict>
<key>StandardOutPath</key><string>${xml(join(dirname(runner),'private/logs/daemon.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(dirname(runner),'private/logs/daemon.log'))}</string>
<key>RunAtLoad</key><false/><key>KeepAlive</key><true/>
</dict></plist>
`;
}

function linuxUnit({node,runner,pathValue}: ServiceCommand) {
  return `[Unit]\nDescription=Rin\n\n[Service]\nType=simple\nExecStart="${systemd(node)}" "${systemd(runner)}"\nEnvironment="PATH=${systemd(pathValue)}"\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`;
}

function windowsRegistration(node: string,runner: string) {
  return `$ErrorActionPreference='Stop';`+
    `$existing=Get-ScheduledTask -TaskName ${ps(WINDOWS_TASK)} -ErrorAction SilentlyContinue;`+
    `if($existing -and ($existing.Actions.Execute -ne ${ps(node)} -or $existing.Actions.Arguments -ne ${ps(`"${runner}"`)})){throw 'Another Rin installation owns this scheduled task'};`+
    `$action=New-ScheduledTaskAction -Execute ${ps(node)} -Argument ${ps(`"${runner}"`)};`+
    `$trigger=New-ScheduledTaskTrigger -AtLogOn;`+
    `$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew;`+
    `Register-ScheduledTask -TaskName ${ps(WINDOWS_TASK)} -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null;`+
    `Disable-ScheduledTask -TaskName ${ps(WINDOWS_TASK)} | Out-Null`;
}

function expectedNotRunning(cause: unknown,platform: NodeJS.Platform) {
  const error=cause as Partial<ExecResult> & {message?: string};
  const code=Number(error?.code);
  const text=`${error?.stderr||''}\n${error?.stdout||''}\n${error?.message||''}`;
  if(platform==='darwin')return code===113||/could not find service|service.*not found/i.test(text);
  if(platform==='linux')return code===3||code===4||/inactive|not loaded|could not be found/i.test(text);
  if(platform==='win32')return code===1&&/not found|cannot find|does not exist/i.test(text);
  return false;
}

function managerDetail(command: string,args: string[],result: Partial<ExecResult>) {
  const exit=result.signal || result.code;
  const output=[result.stdout,result.stderr].filter((value): value is string=>Boolean(value?.trim())).join('\n').trim();
  return `${command} ${args.join(' ')} exited with ${exit ?? 'an unknown status'}${output ? `:\n${output.slice(-16000)}` : ''}`;
}

function managerError(command: string,args: string[],result: Partial<ExecResult>,summary: string) {
  return Object.assign(new Error(`${summary}: ${managerDetail(command,args,result)}`),result);
}

function macJobDetail(domain: string,result: Partial<ExecResult>,label=MAC_LABEL) {
  const args=['print',`${domain}/${label}`];
  if(result.code!==0)return managerDetail('launchctl',args,result);
  const status=String(result.stdout||'').split('\n').filter(line=>/\b(?:state|pid|last exit code|terminating signal)\s*=/.test(line.trim())).join('\n');
  return managerDetail('launchctl',args,{...result,stdout:status,stderr:''});
}

export async function daemonReady(home: string) {
  try {
    const state=JSON.parse(await readFile(join(home,'install.json'),'utf8'));
    const ready=JSON.parse(await readFile(join(home,'private/daemon-ready.json'),'utf8'));
    if(ready.current!==state.current || !Number.isSafeInteger(ready.pid) || ready.pid<=0)return false;
    try{process.kill(ready.pid,0);return true;}catch(error){if(errorCode(error)==='ESRCH')return false;throw error;}
  }catch(error){if(errorCode(error)==='ENOENT')return false;throw error;}
}

export function createService({home,node=process.execPath,platform=process.platform,userHome=homedir(),env=process.env,run=coreRun,isReady=()=>daemonReady(home),timeoutMs=30000,pollMs=250,serviceId}: ServiceOptions): Service {
  if(!home||typeof home!=='string')throw new TypeError('home is required');
  const runner=join(home,'daemon-run.mjs');
  const macLabel=serviceId && /^com\.rin\.[a-z0-9-]+$/.test(serviceId) ? serviceId : MAC_LABEL;
  const pathValue=String(env.PATH||'');
  const uid=String(env.UID??(typeof process.getuid==='function'?process.getuid():''));
  let configPath='';
  if(platform==='darwin')configPath=join(userHome,'Library','LaunchAgents',`${macLabel}.plist`);
  else if(platform==='linux')configPath=join(userHome,'.config','systemd','user',LINUX_UNIT);
  else if(platform!=='win32')throw new Error(`unsupported service platform: ${platform}`);

  const invoke=async(command: string,args: string[],options: ExecOptions={})=>await run(command,args,{env,...options});
  const powershell=(script: string,options: ExecOptions={})=>invoke('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop';${script}`],options);
  const domain=`gui/${uid}`;
  let lastStatus='';

  const macJob=async()=>{
    let result;
    try { result=await invoke('launchctl',['print',`${domain}/${macLabel}`],{capture:true,allowFailure:true}); }
    catch(error) { if(expectedNotRunning(error,'darwin'))return {present:false,running:false}; throw error; }
    if(result?.code!==0) {
      const error=managerError('launchctl',['print',`${domain}/${macLabel}`],result||{},'launchctl status query failed');
      if(expectedNotRunning(error,'darwin'))return {present:false,running:false,detail:macJobDetail(domain,result||{},macLabel)};
      throw error;
    }
    const output=String(result.stdout||'');
    return {present:true,running:/(?:^|\n)\s*(?:state = running|pid = \d+)\s*(?:\n|$)/.test(output),detail:macJobDetail(domain,result,macLabel)};
  };

  const status=async()=>{
    let result;
    try {
      if(platform==='darwin') {
        const job=await macJob();
        lastStatus=job.detail || '';
        return job.running;
      }
      else if(platform==='linux')result=await invoke('systemctl',['--user','is-active','--quiet',LINUX_UNIT],{capture:true,allowFailure:true});
      else result=await powershell(`$task=Get-ScheduledTask -TaskName ${ps(WINDOWS_TASK)} -ErrorAction Stop;if($task.State -ne 'Running'){exit 3}`,{capture:true,allowFailure:true});
    } catch(error) {
      if(expectedNotRunning(error,platform))return false;
      throw error;
    }
    const command=platform==='linux'?'systemctl':'powershell.exe';
    const args=platform==='linux'?['--user','is-active','--quiet',LINUX_UNIT]:['-NoProfile','-NonInteractive','-Command','Get-ScheduledTask Rin'];
    lastStatus=managerDetail(command,args,result||{});
    if(result?.code===0||result?.code==null)return true;
    const error=managerError(command,args,result||{},'service status query failed');
    if(expectedNotRunning(error,platform)||(platform==='win32'&&Number(result.code)===3))return false;
    throw error;
  };

  return {
    async install() {
      if(configPath && await exists(configPath)) {
        const previous=await readFile(configPath,'utf8');
        const marker=platform==='darwin'?xml(runner):systemd(runner);
        if(!previous.includes(marker))throw new Error('Another Rin installation owns this service configuration');
      }
      if(platform==='darwin') {
        if(!uid)throw new Error('macOS service requires a user uid');
        await mkdir(dirname(configPath),{recursive:true});
        await writeFile(configPath,macPlist({node,runner,pathValue},macLabel),{mode:0o644});
        await invoke('launchctl',['disable',`${domain}/${macLabel}`]);
      } else if(platform==='linux') {
        await mkdir(dirname(configPath),{recursive:true});
        await writeFile(configPath,linuxUnit({node,runner,pathValue}),{mode:0o644});
        await invoke('systemctl',['--user','daemon-reload']);
        await invoke('systemctl',['--user','disable',LINUX_UNIT]);
      } else await powershell(windowsRegistration(node,runner));
    },
    async start() {
      if(platform==='darwin') {
        if(!uid)throw new Error('macOS service requires a user uid');
        await invoke('launchctl',['enable',`${domain}/${macLabel}`]);
        if(!(await macJob()).present)await invoke('launchctl',['bootstrap',domain,configPath]);
        // bootstrap registers a disabled-at-load job but does not reliably start it.
        // Always request its first run explicitly, just as for an already-loaded job.
        await invoke('launchctl',['kickstart',`${domain}/${macLabel}`]);
      } else if(platform==='linux') await invoke('systemctl',['--user','enable','--now',LINUX_UNIT]);
      else await powershell(`Enable-ScheduledTask -TaskName ${ps(WINDOWS_TASK)} | Out-Null;Start-ScheduledTask -TaskName ${ps(WINDOWS_TASK)}`);
      let consecutive=0;
      const deadline=Date.now()+timeoutMs;
      while(Date.now()<deadline) {
        consecutive=await status() && await isReady()?consecutive+1:0;
        if(consecutive===2)return;
        await new Promise(resolve=>setTimeout(resolve,pollMs));
      }
      throw new Error(`Rin service did not stay running after start${lastStatus ? `; last service-manager status: ${lastStatus}` : ''}`);
    },
    async stop() {
      if(platform==='darwin') {
        if(!uid)throw new Error('macOS service requires a user uid');
        await invoke('launchctl',['disable',`${domain}/${macLabel}`]);
        const job=await macJob();
        if(job.present) {
          const result=await invoke('launchctl',['bootout',`${domain}/${macLabel}`],{capture:true,allowFailure:true});
          if(result?.code!==0) {
            const error=managerError('launchctl',['bootout',`${domain}/${macLabel}`],result,'launchctl bootout failed');
            if(!expectedNotRunning(error,'darwin'))throw error;
          }
        }
      } else if(platform==='linux') await invoke('systemctl',['--user','disable','--now',LINUX_UNIT]);
      else await powershell(`Stop-ScheduledTask -TaskName ${ps(WINDOWS_TASK)};Disable-ScheduledTask -TaskName ${ps(WINDOWS_TASK)} | Out-Null`);
      for(let attempt=0;attempt<80;attempt++) {
        if(!await status() && !await isReady())return;
        if(attempt<79)await new Promise(resolve=>setTimeout(resolve,250));
      }
      throw new Error('Rin service did not stop');
    },
    async isRunning() {
      return await status();
    },
  };
}
