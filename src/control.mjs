// Local operations only; installation uses the copy under Application Support.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const config=JSON.parse(readFileSync(resolve(root,'private/nerve.json'),'utf8'));
const secrets=JSON.parse(readFileSync(resolve(root,'private/secrets.json'),'utf8'));
const [command='status',id,...words]=process.argv.slice(2);
let path='/events',method='GET',body;
if(command==='health')path='/health';
else if(command==='enqueue'){
 if(!id || !words.length)throw new Error('Usage: control.mjs enqueue UNIQUE_ID PROMPT');
 method='POST';body=JSON.stringify({id,target:'codex',payload:{prompt:words.join(' ')}});
}else if(command!=='status')throw new Error('Usage: control.mjs health|status|enqueue [UNIQUE_ID PROMPT]');
const r=await fetch(`http://127.0.0.1:${config.port || 9761}${path}`,{method,headers:{Authorization:`Bearer ${secrets.NERVE_TOKEN}`,'Content-Type':'application/json'},body,signal:AbortSignal.timeout(10000)});
console.log(await r.text());if(!r.ok)process.exitCode=1;
