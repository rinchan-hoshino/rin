import {spawn, type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {isAbsolute} from 'node:path';
import type {AgentBridge,AgentEvent,AgentInput,CliAgentConfig} from './types.js';

const profiles = {
  'claude-code': {command:'claude',args:(session:string)=>['-p','--resume',session,'--output-format','text']},
  pi: {command:'pi',args:(session:string)=>['-p','--session',session]},
  opencode: {command:'opencode',args:(session:string)=>['run','--session',session]},
} satisfies Record<CliAgentConfig['type'],{command:string;args:(session:string)=>string[]}>;

function prompt(input: AgentInput) {
  if(!input.files.length)return input.text;
  return `${input.text}\n\nAttached local files:\n${input.files.map(file=>`- ${file.path}`).join('\n')}`.trim();
}

/** Runs an already-installed CLI for one turn. It never starts or supervises an agent server. */
export class CliAgentBridge implements AgentBridge {
  onEvent?: (event: AgentEvent) => void;
  config: CliAgentConfig;
  children = new Set<ChildProcess>();
  tails = new Map<string,Promise<void>>();
  stopping=false;
  constructor(config: CliAgentConfig) {
    if(!profiles[config.type])throw new Error(`Unsupported CLI agent: ${String(config.type)}`);
    if(config.cwd && !isAbsolute(config.cwd))throw new Error('CLI agent cwd must be absolute');
    if(config.extraArgs?.some(arg=>typeof arg!=='string'))throw new Error('CLI agent extraArgs must contain strings');
    this.config=config;
  }
  async start(){this.stopping=false;}
  async watch(){/* CLI output is observed from the process started by queue(). */}
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
    const run=previous.catch(()=>{}).then(()=>this.run(threadId,turnId,itemId,prompt(input),ready,rejectReady));
    let tail:Promise<void>;
    tail=run.catch(()=>{}).finally(()=>{if(this.tails.get(threadId)===tail)this.tails.delete(threadId);});
    this.tails.set(threadId,tail);
    await started;
    return {transport:`${this.config.type}-cli`,turnId} as const;
  }
  private async run(threadId:string,turnId:string,itemId:string,text:string,ready:()=>void,rejectReady:(error:unknown)=>void){
    const profile=profiles[this.config.type];
    const command=this.config.command || profile.command;
    const args=[...profile.args(threadId),...(this.config.extraArgs || []),text];
    await new Promise<void>((resolveRun,rejectRun)=>{
      const child=spawn(command,args,{cwd:this.config.cwd,env:{...process.env,...this.config.env},stdio:['ignore','pipe','pipe'],windowsHide:true});
      this.children.add(child);
      let stdout='',stderr='';
      child.stdout?.on('data',chunk=>{stdout+=chunk;});
      child.stderr?.on('data',chunk=>{stderr+=chunk;});
      child.once('spawn',()=>{this.onEvent?.({threadId,turnId,type:'started'});ready();});
      child.once('error',error=>{this.children.delete(child);rejectReady(error);this.onEvent?.({threadId,turnId,type:'failed',error});rejectRun(error);});
      child.once('close',(code,signal)=>{
        this.children.delete(child);
        if(code===0){
          const answer=stdout.trim();
          if(answer)this.onEvent?.({threadId,turnId,type:'text',itemId,phase:'final',text:answer,done:true});
          this.onEvent?.({threadId,turnId,type:'completed'});resolveRun();
        }else{
          const error=new Error(`${command} exited with ${signal || code}${stderr.trim()?`: ${stderr.trim().slice(-4000)}`:''}`);
          this.onEvent?.({threadId,turnId,type:'failed',error});rejectRun(error);
        }
      });
    });
  }
}
