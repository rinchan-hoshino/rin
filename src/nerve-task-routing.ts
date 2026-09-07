import {DatabaseSync} from 'node:sqlite';
import {statSync} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {CodexAppServer} from './codex-app-server.js';
import type {TaskRoutingConfig} from './nerve-types.js';
import {validateTaskId} from './nerve-config.js';
export {validateTaskId} from './nerve-config.js';
export function validateSource(value:unknown):asserts value is string {
  if(typeof value!=='string' || !value.trim() || value.length>200)throw new Error('Stable producer source required (1-200 characters)');
}
export function validateExistingTask(threadId:string,config:TaskRoutingConfig){
  validateTaskId(threadId);
  const db=new DatabaseSync(join(config.codexHome || process.env.CODEX_HOME || join(homedir(),'.codex'),'state_5.sqlite'),{readOnly:true});
  try {
    if(!db.prepare('SELECT id FROM threads WHERE id=? AND archived=0').get(threadId))throw new Error('Task does not exist or is archived');
  } finally {db.close();}
}

export interface TaskCreation {id:string;target:string;source:string;cwd:string;name?:string}
export interface CreationReceipt {id:string;definition:string;state:string;threadId:string|null;error:string|null}
export interface TaskRouteStore {
  db:DatabaseSync;
  bindTask(target:string,source:string,threadId:string|null):unknown;
  taskCreation(id:string):CreationReceipt|null;
}

/** An explicit setup operation, never a model execution or event retry loop. */
export async function createAndBindTask(store:TaskRouteStore,input:TaskCreation,config:TaskRoutingConfig,server=new CodexAppServer(config)){
  validateSource(input.id);validateSource(input.source);
  if(typeof input.cwd!=='string' || !isAbsolute(input.cwd) || !statSync(input.cwd).isDirectory())throw new Error('Existing absolute working directory required');
  if(input.name!==undefined && (typeof input.name!=='string' || !input.name.trim() || input.name.length>200))throw new Error('Task name must contain 1-200 characters');
  const definition=JSON.stringify({target:input.target,source:input.source,cwd:input.cwd,...(input.name===undefined?{}:{name:input.name})});
  const claim=store.db.prepare("INSERT OR IGNORE INTO task_creations(id,definition,state) VALUES(?,?,'pending')").run(input.id,definition);
  if(!claim.changes){
    const previous=store.taskCreation(input.id)!;
    if(previous.definition!==definition)throw new Error('Creation ID reused with different arguments');
    return previous; // Pending/uncertain receipts must never create another task.
  }
  let threadId:string|null=null;
  try {
    server.start();await server.connect();
    const result=await server.request<{thread?:{id?:string}}>('thread/start',{cwd:input.cwd});
    validateTaskId(result?.thread?.id);threadId=result.thread.id;
    store.db.prepare("UPDATE task_creations SET state='created',threadId=? WHERE id=?").run(threadId,input.id);
    // Empty native tasks need one persisted item; this does not start a turn.
    await server.request('thread/inject_items',{threadId,items:[{type:'message',role:'developer',content:[{type:'input_text',text:'This task receives events from Rin. Read the event and carry out its request using the applicable instructions.'}]}]});
    if(input.name!==undefined)await server.request('thread/name/set',{threadId,name:input.name});
    store.db.exec('BEGIN IMMEDIATE');
    try {
      store.bindTask(input.target,input.source,threadId);
      store.db.prepare("UPDATE task_creations SET state='bound',error=NULL WHERE id=?").run(input.id);
      store.db.exec('COMMIT');
    } catch(error){store.db.exec('ROLLBACK');throw error;}
  } catch {
    store.db.prepare("UPDATE task_creations SET state='uncertain',threadId=?,error=? WHERE id=?").run(threadId,'Creation or binding incomplete; inspect the recorded task before recovery. This ID will not create another task.',input.id);
  } finally {await server.stop();}
  return store.taskCreation(input.id)!;
}
