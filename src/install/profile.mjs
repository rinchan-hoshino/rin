import { spawn } from 'node:child_process';

export const RIN_RECOMMENDED_CODEX_EDITS = Object.freeze([
  ['features.context_management.experimental_mode', true],
  ['features.memories', true],
  ['tool_output_token_limit', 4000],
  ['sandbox_mode', 'danger-full-access'],
  ['approval_policy', 'never'],
  ['desktop.preventSleepWhileRunning', true],
  ['desktop.keepRemoteControlAwakeWhilePluggedIn', true],
  ['desktop.git-branch-prefix', ''],
  ['desktop.git-pull-request-merge-method', 'squash'],
  ['desktop.worktree-upstream-refresh-mode', 'best-effort'],
  ['apps.connector_20205bf7d4e99a89d7154bb849718324.enabled', false],
  ['apps.connector_openai_hotline.enabled', false],
  ['apps.connector_openai_safety_settings.enabled', false],
].map(([keyPath,value])=>Object.freeze({keyPath,value,mergeStrategy:'upsert'})));

export function createCodexConfigWriter({ command, codexHome, spawnImpl = spawn, timeoutMs = 15_000 }) {
  if(!command?.command)throw new TypeError('Codex command is required');
  return async params => new Promise((resolve,reject)=>{
    const env=codexHome?{...process.env,CODEX_HOME:codexHome}:process.env;
    const child=spawnImpl(command.command,[...(command.args || []),'app-server','--stdio'],{env,stdio:['pipe','pipe','pipe']});
    let buffer='',settled=false,nextId=1;
    const pending=new Map();
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);child.kill();error?reject(error):resolve(value);};
    const request=(method,requestParams)=>new Promise((accept,decline)=>{
      const id=nextId++;pending.set(String(id),{accept,decline});
      child.stdin.write(`${JSON.stringify({id,method,params:requestParams})}\n`);
    });
    const timer=setTimeout(()=>finish(new Error('Codex configuration write timed out')),timeoutMs);
    child.stderr.on('data',()=>{});
    child.stdin.on('error',()=>finish(new Error('Codex configuration writer input failed')));
    child.stdout.on('data',chunk=>{
      buffer+=chunk.toString();const lines=buffer.split('\n');buffer=lines.pop() || '';
      for(const line of lines){
        let message;try{message=JSON.parse(line);}catch{continue;}
        const entry=pending.get(String(message.id));if(!entry)continue;
        pending.delete(String(message.id));
        if(message.error)entry.decline(new Error(message.error.message || 'Codex configuration write failed'));
        else entry.accept(message.result);
      }
    });
    child.once('error',finish);
    child.once('exit',code=>{if(!settled)finish(new Error(`Codex configuration writer exited (${code})`));});
    (async()=>{
      try{
        await request('initialize',{clientInfo:{name:'rin-installer',title:'Rin installer',version:'1'},capabilities:{experimentalApi:true,requestAttestation:false}});
        finish(null,await request('config/batchWrite',params));
      }catch(error){finish(error);}
    })();
  });
}

export async function applyRecommendedCodexProfile({ codexHome, command, writeConfig } = {}) {
  if(!codexHome)throw new TypeError('codexHome is required');
  const writer=writeConfig || createCodexConfigWriter({command,codexHome});
  return writer({
    edits:RIN_RECOMMENDED_CODEX_EDITS.map(edit=>({...edit})),
    reloadUserConfig:true,
  });
}
