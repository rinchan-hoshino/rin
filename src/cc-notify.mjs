// Optional Nerve output. A destination must be explicitly configured; never pick
// the first active chat. No target is enabled by the local installation.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const [project,session]=process.argv.slice(2);
if(!project || !session)throw new Error('Explicit project and session are required');
const chunks=[];for await(const b of process.stdin)chunks.push(b);
const {payload}=JSON.parse(Buffer.concat(chunks).toString());
if(typeof payload?.text!=='string' || !payload.text.trim())throw new Error('payload.text required');
const env={...process.env};for(const k of ['NERVE_TOKEN','TELEGRAM_BOT_TOKEN','DISCORD_BOT_TOKEN'])delete env[k];
const child=spawn(process.env.CC_CONNECT_BIN || resolve(root,'.local/bin/cc-connect'),[
 'send','--data-dir',resolve(root,'private/bridge-data'),'--project',project,'--session',session,'--stdin'
],{env,stdio:['pipe','inherit','inherit']});
child.stdin.on('error',()=>{});child.stdin.end(payload.text);
child.on('error',e=>{console.error(e.message);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
