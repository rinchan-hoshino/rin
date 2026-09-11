import {createHash} from 'node:crypto';
import type {CodexAppServer} from '../codex-app-server.js';
import type {CodexEvent} from './types.js';

type Item={id:string;type:string;text?:string;phase?:string;delivery?:string;questions?:unknown[];summary?:string[];clientId?:string;status?:string;savedPath?:string};
type Turn={id:string;status:string;error?:{message?:string}};
type Page<T>={data:T[];nextCursor:string|null};
type Snapshot={status:string;items:Record<string,{ordinal:number;hash:string}>};
type Cursor={version:2;anchor?:string;turns:Record<string,Snapshot>};
interface Options {server:CodexAppServer;threadId:string;pollMs:number;emit:(event:CodexEvent)=>void;getCursor?:(key:string)=>unknown;setCursor?:(key:string,value:unknown)=>void;}
const terminal=(status:string)=>['completed','failed','interrupted'].includes(status);
function project(item:Item,threadId:string,turnId:string,ordinal:number):CodexEvent|undefined {
  const base={threadId,turnId,itemId:item.id,ordinal};
  if(item.type==='userMessage')return {...base,type:'input',...(item.clientId?{clientMessageId:item.clientId}:{})};
  if(item.type==='agentMessage' && item.text)return {...base,type:'text',text:item.text,phase:item.delivery==='async'||item.questions?.length?'question':!item.phase||item.phase==='final_answer'?'final':item.phase};
  if(item.type==='reasoning' && item.summary?.length)return {...base,type:'text',phase:'summary',text:item.summary.filter(Boolean).at(-1)};
  if(item.type==='imageGeneration' && item.status==='completed' && item.savedPath)return {...base,type:'image',path:item.savedPath};
}

/** Read-only app-server history; transport loss never causes a model input retry. */
export async function observeCodexHistory(options:Options) {
  const {server,threadId,pollMs,emit,getCursor,setCursor}=options;
  const key=`codex-observer:${threadId}`;
  let saved=getCursor?.(key);
  if(typeof saved==='string')saved=JSON.parse(saved);
  const legacy=saved as {version?:number;activeTurns?:{turnId:string}[]}|undefined;
  let state:Cursor=legacy?.version===2?structuredClone(saved as Cursor):{version:2,turns:{}};
  if(!state.turns || typeof state.turns!=='object')throw Error('Invalid Codex observer checkpoint');
  const recovering=new Set(legacy?.version!==2?legacy?.activeTurns?.map(t=>t.turnId):[]);
  let stopped=false,busy=false,timer:ReturnType<typeof setTimeout>|undefined,lastError='';
  const save=()=>setCursor?.(key,structuredClone(state));
  async function pages<T>(method:string,params:Record<string,unknown>,visit:(rows:T[])=>boolean|void) {
    let cursor:string|undefined;const seen=new Set<string>();
    do {
      const page=await server.request<Page<T>>(method,{...params,limit:100,...(cursor?{cursor}:{})});
      if(!Array.isArray(page.data))throw Error(`Invalid ${method} response`);
      if(stopped)return;
      if(visit(page.data)===false)return;
      cursor=page.nextCursor || undefined;
      if(cursor && seen.has(cursor))throw Error(`Repeated ${method} page cursor`);
      if(cursor)seen.add(cursor);
    }while(cursor);
  }
  async function readItems(turnId:string) {
    const rows:Item[]=[];
    await pages<{turnId:string;item:Item}>('thread/items/list',{threadId,turnId,sortDirection:'asc'},entries=>{for(const e of entries){if(e.turnId!==turnId || !e.item?.id)throw Error('Invalid thread item identity');rows.push(e.item);}});
    return rows;
  }
  async function scan(initial=false) {
    await server.connect({bootstrap:false});
    const turns:Turn[]=[];
    const needed=new Set(Object.entries(state.turns).filter(([,v])=>!terminal(v.status)).map(([id])=>id));
    if(state.anchor)needed.add(state.anchor);
    for(const id of recovering)needed.add(id);
    await pages<Turn>('thread/turns/list',{threadId,sortDirection:'desc',itemsView:'notLoaded'},rows=>{
      for(const t of rows){if(!t.id || !t.status)throw Error('Invalid thread turn identity');turns.push(t);needed.delete(t.id);}
      if((state.anchor || recovering.size) && needed.size===0)return false;
    });
    if(stopped)return;
    if(needed.size)throw Error('Observed Codex history is missing a saved turn');
    const latest=turns[0]?.id;
    const baseline=initial && legacy?.version!==2;
    if(baseline && recovering.size)emit({threadId,turnId:'',type:'orderReset'});
    const recoveryIndex=turns.findLastIndex(t=>recovering.has(t.id));
    const anchorIndex=state.anchor?turns.findIndex(t=>t.id===state.anchor):-1;
    if(!initial && state.anchor && anchorIndex<0)throw Error('Observed Codex history anchor is no longer present');
    for(let index=turns.length-1;index>=0;index--) {
      const turn=turns[index],old=state.turns[turn.id];
      const recover=recoveryIndex>=0 && index<=recoveryIndex;
      if(baseline && terminal(turn.status) && turn.id!==latest && !recover)continue;
      if(!baseline && !old && anchorIndex>=0 && index>anchorIndex)continue;
      if(!baseline && old && terminal(old.status) && turn.id!==state.anchor)continue;
      const suppress=baseline && !recover;
      const items=await readItems(turn.id);if(stopped)return;
      const snapshot:Snapshot={status:turn.status,items:{}};
      const changes:CodexEvent[]=[];
      for(const [ordinal,item] of items.entries()) {
        const event=project(item,threadId,turn.id,ordinal);
        if(!event)continue;
        const hash=createHash('sha256').update(JSON.stringify(event)).digest('hex');
        snapshot.items[item.id]={ordinal,hash};
        if(old?.items[item.id] && old.items[item.id].ordinal!==ordinal)throw Error('Observed Codex item order changed');
        if(!suppress && old?.items[item.id]?.hash!==hash)changes.push(event);
      }
      if(!suppress) {
        if(!old)emit({threadId,turnId:turn.id,type:'started'});
        // Establish every steer boundary before processing changed old output.
        for(const event of [...changes.filter(e=>e.type==='input'),...changes.filter(e=>e.type!=='input')])emit(event);
        if(terminal(turn.status) && old?.status!==turn.status)emit({threadId,turnId:turn.id,type:turn.status==='completed'?'completed':'failed',...(turn.error?.message?{text:turn.error.message}:{})});
      }
      state.turns[turn.id]=snapshot;
      if(!baseline)save();
    }
    state.anchor=latest;
    state.turns=Object.fromEntries(Object.entries(state.turns).filter(([id,s])=>id===latest || !terminal(s.status)));
    recovering.clear();save();
  }
  async function poll() {
    if(stopped||busy)return;busy=true;
    try {await scan();if(lastError && !stopped){emit({threadId,turnId:'',type:'observerReady'});for(const [turnId,s] of Object.entries(state.turns))if(!terminal(s.status))emit({threadId,turnId,type:'started'});}lastError='';}
    catch(error) {if(!stopped){const text=error instanceof Error?error.message:String(error);if(text!==lastError)emit({threadId,turnId:'',type:'observerError',text});lastError=text;}}
    finally {busy=false;if(!stopped){timer=setTimeout(poll,lastError?Math.max(pollMs,1000):pollMs);timer.unref?.();}}
  }
  await scan(true);
  timer=setTimeout(poll,pollMs);timer.unref?.();
  return ()=>{stopped=true;clearTimeout(timer);};
}
