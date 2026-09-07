import {CodexInput} from './codex-input.js';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateTaskId} from './nerve-config.js';

/** A command target for generic event producers; exits at host admission. */
export async function submitEvent(defaultThreadId:string,event:{id:string;payload:{prompt:string};threadId?:string},bridge=new CodexInput()) {
  const threadId=event.threadId ?? defaultThreadId;
  validateTaskId(threadId);
  if(typeof event.id!=='string' || typeof event.payload?.prompt!=='string' || !event.payload.prompt.trim())throw new Error('Event id and payload.prompt required');
  let submitted=false;
  try {
    await bridge.start();
    const receipt=await bridge.queue(threadId,{text:`External event ${event.id}\n\n${event.payload.prompt}`,onClientMessageId:()=>{submitted=true;}});
    return {accepted:true,receipt};
  } catch(error) {
    return {accepted:false,retryable:!submitted,error:(error as Error).message};
  } finally {await bridge.stop();}
}
export async function main() {
  let input='';
  for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>1048576)throw new Error('Input too large');}
  process.stdout.write(JSON.stringify(await submitEvent(process.argv[2],JSON.parse(input),new CodexInput({endpoint:process.argv[3]})))+'\n');
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
