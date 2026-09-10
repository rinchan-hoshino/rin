import {spawn, type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {isAbsolute} from 'node:path';
import type {AgentBridge,AgentEvent,AgentInput,CliAgentConfig} from './types.js';

const profiles = {
  'claude-code': {command:'claude',args:['-p','--input-format','stream-json','--output-format','stream-json','--verbose'],resume:'--resume',reserved:['--resume','-r','--continue','-c','--session-id','--fork-session','--no-session-persistence','--output-format','--input-format']},
  pi: {command:'pi',args:['-p','--mode','json'],resume:'--session',reserved:['--session','--session-id','--resume','-r','--continue','-c','--fork','--no-session','--mode']},
  opencode: {command:'opencode',args:['run','--format','json'],resume:'--session',reserved:['--session','-s','--continue','-c','--fork','--format']},
} satisfies Record<CliAgentConfig['type'],{command:string;args:string[];resume:string;reserved:string[]}>;

interface Session {cwd:string;model?:string;state:'new'|'starting'|'ready';nativeId?:string;}
const sessionPrefix='rin-session:';
const record=(value:unknown):Record<string,unknown>=>value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
const string=(value:unknown)=>typeof value==='string' ? value : '';
function contentText(value:unknown) {
  return Array.isArray(value) ? value.map(record).filter(part=>part.type==='text').map(part=>string(part.text)).join('\n') : '';
}

/** Only public answer fields are forwarded; tool results and reasoning stay in the agent. */
class TurnOutput {
  text='';done=false;error='';
  constructor(private type:CliAgentConfig['type'],private session:(id:string)=>void){}
  read(value:unknown) {
    const event=record(value),message=record(event.message),part=record(event.part);
    if(this.type==='claude-code') {
      if(event.parent_tool_use_id)return;
      if(event.type==='system' && event.subtype==='init' || event.type==='result') {
        const id=string(event.session_id);if(id)this.session(id);
      }
      if(event.type==='result') {
        this.done=true;
        if(event.is_error===true || string(event.subtype).startsWith('error'))this.error='Claude Code reported an unsuccessful turn';
        else this.text=string(event.result);
      }
    } else if(this.type==='pi') {
      if(event.type==='session') {const id=string(event.id);if(id)this.session(id);}
      if(event.type==='message_end' && message.role==='assistant')this.assistant(message);
      if(event.type==='agent_end') {
        this.done=true;
        const messages=Array.isArray(event.messages) ? event.messages.map(record) : [];
        const last=messages.findLast(item=>item.role==='assistant');if(last)this.assistant(last);
      }
    } else {
      const id=string(event.sessionID);if(id)this.session(id);
      if(event.type==='step_start')this.text='';
      if(event.type==='text')this.text+=(this.text?'\n':'')+string(part.text);
      if(event.type==='step_finish' && ['stop','length'].includes(string(part.reason)))this.done=true;
      if(event.type==='error')this.error='OpenCode reported an unsuccessful turn';
    }
  }
  private assistant(message:Record<string,unknown>) {
    if(['error','aborted'].includes(string(message.stopReason)))this.error='pi reported an unsuccessful turn';
    this.text=contentText(message.content);
  }
}

function prompt(input: AgentInput) {
  if(!input.files.length)return input.text;
  return `${input.text}\n\nAttached local files:\n${input.files.map(file=>`- ${file.path}`).join('\n')}`.trim();
}

/** The native CLI creates a session on its first turn and owns its history. */
export class CliAgentBridge implements AgentBridge {
  onEvent?: (event: AgentEvent) => void;
  getCursor?: (key:string)=>unknown;
  setCursor?: (key:string,value:unknown)=>void;
  config: CliAgentConfig;
  children = new Set<ChildProcess>();
  tails = new Map<string,Promise<void>>();
  stopping=false;
  constructor(config: CliAgentConfig) {
    if(!profiles[config.type])throw new Error(`Unsupported CLI agent: ${String(config.type)}`);
    if(config.cwd && !isAbsolute(config.cwd))throw new Error('CLI agent cwd must be absolute');
    if(config.extraArgs?.some(arg=>typeof arg!=='string'))throw new Error('CLI agent extraArgs must contain strings');
    if(config.extraArgs?.some(arg=>arg==='--' || profiles[config.type].reserved.includes(arg.split('=')[0]!)))throw new Error('CLI agent extraArgs cannot override session or output controls');
    this.config=config;
  }
  async start(){this.stopping=false;}
  async watch(){/* CLI output is observed from the process started by queue(). */}
  async createThread({cwd,model}:{cwd:string;model?:string;name?:string}) {
    if(!isAbsolute(cwd))throw new Error('Agent session cwd must be absolute');
    if(!this.getCursor || !this.setCursor)throw new Error('Persistent session storage is required');
    const id=sessionPrefix+randomUUID();
    this.setCursor(this.sessionKey(id),{cwd,...(model?{model}:{}),state:'new'} satisfies Session);
    return id;
  }
  private sessionKey(id:string){return `agent-session:${this.config.type}:${id}`;}
  async stop(){
    this.stopping=true;
    for(const child of this.children)child.kill('SIGTERM');
    await Promise.allSettled([...this.tails.values()]);
  }
  async queue(threadId:string,input:AgentInput){
    if(this.stopping)throw new Error('Agent bridge is stopping');
    const turnId=randomUUID(), itemId=randomUUID();
    const previous=this.tails.get(threadId) || Promise.resolve();
    let ready!:()=>void,rejectReady!:(error:unknown)=>void;
    const started=new Promise<void>((resolveStarted,rejectStarted)=>{ready=resolveStarted;rejectReady=rejectStarted;});
    const run=previous.catch(()=>{}).then(()=>this.run(threadId,turnId,itemId,prompt(input),ready)).catch(error=>{
      rejectReady(error);this.onEvent?.({threadId,turnId,type:'failed',error});throw error;
    });
    let tail:Promise<void>;
    tail=run.catch(()=>{}).finally(()=>{if(this.tails.get(threadId)===tail)this.tails.delete(threadId);});
    this.tails.set(threadId,tail);
    await started;
    return {transport:`${this.config.type}-cli`,turnId} as const;
  }
  private async run(threadId:string,turnId:string,itemId:string,text:string,ready:()=>void){
    if(this.stopping)throw new Error('Agent bridge is stopping');
    const managed=threadId.startsWith(sessionPrefix);
    const session:Session|undefined=managed ? this.getCursor?.(this.sessionKey(threadId)) as Session | undefined : {cwd:this.config.cwd || process.cwd(),state:'ready',nativeId:threadId};
    if(!session)throw new Error('Agent session metadata is missing');
    if(session.state==='starting' && !session.nativeId)throw new Error('Previous agent session creation was not confirmed; inspect the native agent before continuing');
    const fresh=managed && session.state==='new';
    const profile=profiles[this.config.type],command=this.config.command || profile.command;
    const args=[...profile.args,...(session.nativeId?[profile.resume,session.nativeId]:[]),...(session.model?['--model',session.model]:[]),...(this.config.extraArgs || [])];
    const save=()=>{if(managed)this.setCursor!(this.sessionKey(threadId),session);};
    const output=new TurnOutput(this.config.type,id=>{
      if(managed && session.nativeId && session.nativeId!==id)throw new Error('Agent returned a different session');
      if(managed && !session.nativeId){session.nativeId=id;session.state='ready';save();}
    });
    if(fresh){session.state='starting';save();}
    await new Promise<void>((resolveRun,rejectRun)=>{
      const child=spawn(command,args,{cwd:session.cwd,env:{...process.env,...this.config.env},stdio:['pipe','pipe','pipe'],windowsHide:true});
      this.children.add(child);
      let buffer='',stderr='',protocolError='';
      const readLine=(line:string)=>{
        if(!line.trim())return;
        try {output.read(JSON.parse(line));}catch {protocolError='Agent returned invalid session output';}
      };
      child.stdout?.setEncoding('utf8');child.stderr?.setEncoding('utf8');
      // A message is input, including leading CLI flags or @file-like text.
      child.stdin?.on('error',()=>{/* Process completion reports rejected input. */});
      child.stdin?.end(this.config.type==='claude-code' ? JSON.stringify({type:'user',session_id:session.nativeId || '',message:{role:'user',content:[{type:'text',text}]},parent_tool_use_id:null})+'\n' : text);
      child.stdout?.on('data',(chunk:string)=>{
        buffer+=chunk;
        let at:number;while((at=buffer.indexOf('\n'))!==-1){readLine(buffer.slice(0,at));buffer=buffer.slice(at+1);}
      });
      child.stderr?.on('data',(chunk:string)=>{stderr=(stderr+chunk).slice(-4000);});
      child.once('spawn',()=>{this.onEvent?.({threadId,turnId,type:'started'});ready();});
      child.once('error',error=>{
        this.children.delete(child);
        if(fresh && !session.nativeId){session.state='new';save();}
        rejectRun(error);
      });
      child.once('close',(code,signal)=>{
        this.children.delete(child);readLine(buffer);
        if(code!==0){rejectRun(new Error(`${command} exited with ${signal || code}${stderr.trim()?`: ${stderr.trim()}`:''}`));return;}
        const error=protocolError || output.error || (!output.done?'Agent returned no completed turn':'') || (managed && !session.nativeId?'Agent returned no session ID':'');
        if(error){rejectRun(new Error(error));return;}
        const answer=output.text.trim();
        if(answer)this.onEvent?.({threadId,turnId,type:'text',itemId,phase:'final',text:answer,done:true});
        this.onEvent?.({threadId,turnId,type:'completed'});resolveRun();
      });
    });
  }
}
