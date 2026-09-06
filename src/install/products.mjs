import {createHash} from 'node:crypto';
import {access,chmod,copyFile,lstat,mkdir,mkdtemp,readFile,readlink,rm,symlink,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {codexCommand as resolveCodex,findNpmCli,run as coreRun} from './core.mjs';

// Resolved from the download links on https://learn.chatgpt.com/docs/app and /docs/linux/linux-app.
const CHATGPT_DOWNLOADS={
  darwin:'https://persistent.oaistatic.com/codex-app-prod/Codex.dmg',
  deb:{x64:'https://persistent.oaistatic.com/codex-app-prod/linux/deb/latest/chatgpt_amd64.deb',arm64:'https://persistent.oaistatic.com/codex-app-prod/linux/deb/latest/chatgpt_arm64.deb'},
  rpm:{x64:'https://persistent.oaistatic.com/codex-app-prod/linux/rpm/latest/chatgpt.x86_64.rpm',arm64:'https://persistent.oaistatic.com/codex-app-prod/linux/rpm/latest/chatgpt.aarch64.rpm'},
};
const FFF={
  version:'0.10.6',
  base:'https://github.com/dmtrKovalenko/fff/releases/download/v0.10.6',
  assets:{
    'darwin-arm64':{name:'fff-mcp-aarch64-apple-darwin',sha256:'02e0f57f5b88fa698494f310d8005a0c34d5bda5a1fcd069520b35f8e2319892'},
    'darwin-x64':{name:'fff-mcp-x86_64-apple-darwin',sha256:'12f374554f1930434cacee8221d9a76afd9e4dde0d9112c3bbc3ea59d5b56e83'},
    'linux-arm64-gnu':{name:'fff-mcp-aarch64-unknown-linux-gnu',sha256:'c557a0fc6463d013bd1850e8d2cfbd823b5ff41a7386e0803ab552ef55c6bf31'},
    'linux-arm64-musl':{name:'fff-mcp-aarch64-unknown-linux-musl',sha256:'028b9e388716a8c0c39de3f153dd8e14e5ee998ffa70d4951f1cd2a3fc42f6ce'},
    'linux-x64-gnu':{name:'fff-mcp-x86_64-unknown-linux-gnu',sha256:'3b887b272d580f34f9fe6c60cd126be54c4a7cf5f8ffb122d86c81f29b98524e'},
    'linux-x64-musl':{name:'fff-mcp-x86_64-unknown-linux-musl',sha256:'a44ef64015f1754aa63b690c24d9a748ed16298f05350da7b09554c4c98dfb0f'},
    'win32-arm64':{name:'fff-mcp-aarch64-pc-windows-msvc.exe',sha256:'9151f6efc9d5aa9e38aafb7fb2c664700fa950374717305ad41a09a54cfe873e'},
    'win32-x64':{name:'fff-mcp-x86_64-pc-windows-msvc.exe',sha256:'460e0614f4e8d6b6b618ec9b4bc5eeb58d70601d8b62c7947cc66435a182f946'},
  },
};

export const execCommand=coreRun;

export async function downloadFile(url,destination,{fetchImpl=globalThis.fetch}={}){
  const response=await fetchImpl(url);
  if(!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  await writeFile(destination,Buffer.from(await response.arrayBuffer()),{mode:0o600});
  return destination;
}
async function verifySha256(path,expected){
  const actual=createHash('sha256').update(await readFile(path)).digest('hex');
  if(actual!==expected) throw new Error(`FFF checksum mismatch for v${FFF.version}`);
}

function assertOk(result,label){
  if(result?.code!==0) throw new Error(`${label} failed${result?.stderr?`: ${String(result.stderr).trim()}`:''}`);
  return result;
}
async function pathExists(path){try{await access(path);return true;}catch{return false;}}
function normalizeArch(arch){
  if(['x64','x86_64','amd64'].includes(arch)) return 'x64';
  if(['arm64','aarch64'].includes(arch)) return 'arm64';
  throw new Error(`Unsupported architecture: ${arch}`);
}
function parseOsRelease(text){
  return Object.fromEntries(String(text).split(/\r?\n/).map(line=>line.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map(([,key,value])=>[key,value.replace(/^['"]|['"]$/g,'')]));
}
function supportedLinux(os){
  const id=String(os.ID||'').toLowerCase(),version=String(os.VERSION_ID||'');
  if(id==='ubuntu'&&['24.04','26.04'].includes(version)) return 'deb';
  if(id==='debian'&&version==='13') return 'deb';
  if(id==='fedora'&&['43','44'].includes(version)) return 'rpm';
  throw new Error(`Unsupported Linux distribution: ${id||'unknown'} ${version||'unknown'}`);
}
function fffAsset({platform=process.platform,arch=process.arch,libc}={}){
  const normalized=normalizeArch(arch);
  const family=platform==='linux'?(libc??(process.report?.getReport()?.header?.glibcVersionRuntime?'gnu':'musl')):null;
  const key=platform==='linux'?`${platform}-${normalized}-${family}`:`${platform}-${normalized}`;
  const asset=FFF.assets[key];
  return asset?{...asset,key,url:`${FFF.base}/${asset.name}`} : null;
}
export function historySupport(options={}){
  try{
    const asset=fffAsset(options);
    return asset?{supported:true,version:FFF.version,asset:asset.name}:{supported:false,reason:`FFF v${FFF.version} has no vetted binary for this platform`};
  }catch(error){return {supported:false,reason:error.message};}
}
export async function installProducts({products,home,userHome=homedir(),platform=process.platform,arch=process.arch,node=process.execPath,npmCli,run=execCommand,download=downloadFile,exists=pathExists,osRelease}={}){
  if(!Array.isArray(products)) throw new TypeError('products must be an array');
  if(typeof home!=='string'||!home) throw new TypeError('home is required');
  const requested=[...new Set(products)];
  for(const product of requested) if(!['codex','chatgpt'].includes(product)) throw new Error(`Unknown product: ${product}`);

  // Reject unsupported ChatGPT targets before any selected product mutates the machine.
  let linuxKind,linuxArch;
  if(requested.includes('chatgpt')&&platform==='linux'){
    linuxArch=normalizeArch(arch);
    const release=osRelease??parseOsRelease(await readFile('/etc/os-release','utf8'));
    linuxKind=supportedLinux(release);
  }else if(requested.includes('chatgpt')&&platform==='darwin'){
    if(normalizeArch(arch)!=='arm64') throw new Error('The official macOS ChatGPT download currently supports Apple Silicon only');
  }else if(requested.includes('chatgpt')&&!['win32'].includes(platform)) throw new Error(`ChatGPT is unsupported on platform: ${platform}`);

  const results=[];
  for(const product of requested){
    if(product==='codex'){
      const npmScript=npmCli??await findNpmCli({node,platform});
      const prefix=platform==='win32'
        ? (await run(node,[npmScript,'prefix','--global'],{capture:true})).stdout.trim()
        : join(userHome,'.local');
      if(!prefix) throw new Error('npm returned an empty global installation prefix');
      const legacy=join(userHome,'.rin'),fromLegacy=relative(legacy,resolve(prefix));
      if(fromLegacy===''||(!fromLegacy.startsWith('..')&&!isAbsolute(fromLegacy))) throw new Error('npm global prefix points inside the old ~/.rin installation; choose a fresh Node.js/npm installation and retry');
      const args=['install','--global',...(platform==='win32'?[]:['--prefix',prefix]),'@openai/codex'];
      assertOk(await run(node,[npmScript,...args]), 'Codex npm installation');
      results.push({product,status:'installed',command:platform==='win32'?join(prefix,'codex.cmd'):join(prefix,'bin','codex')});
      continue;
    }
    if(platform==='win32'){
      assertOk(await run('winget',['install','--id','9PLM9XGG6VKS','-s','msstore']), 'ChatGPT installation');
      results.push({product,status:'installed',source:'msstore'}); continue;
    }
    if(platform==='darwin'){
      const candidates=['/Applications/ChatGPT.app','/Applications/Codex.app',join(userHome,'Applications','ChatGPT.app'),join(userHome,'Applications','Codex.app')];
      const existing=(await Promise.all(candidates.map(async path=>await exists(path)?path:null))).find(Boolean);
      if(existing){results.push({product,status:'existing',path:existing});continue;}
      const destination=join(userHome,'Applications','ChatGPT.app');
      const work=await mkdtemp(join(tmpdir(),'rin-chatgpt-')),dmg=join(work,'ChatGPT.dmg'),mount=join(work,'mount');
      let mounted=false;
      try{
        await mkdir(mount); await download(CHATGPT_DOWNLOADS.darwin,dmg);
        assertOk(await run('hdiutil',['attach',dmg,'-nobrowse','-readonly','-mountpoint',mount]),'Mounting ChatGPT disk image'); mounted=true;
        const source=(await exists(join(mount,'ChatGPT.app')))?join(mount,'ChatGPT.app'):join(mount,'Codex.app');
        if(!await exists(source)) throw new Error('The official disk image did not contain ChatGPT.app');
        await mkdir(join(userHome,'Applications'),{recursive:true});
        assertOk(await run('ditto',[source,destination]),'Copying ChatGPT application');
      }finally{
        if(mounted) assertOk(await run('hdiutil',['detach',mount]),'Detaching ChatGPT disk image');
        await rm(work,{recursive:true,force:true});
      }
      results.push({product,status:'installed',path:destination}); continue;
    }
    const suffix=linuxKind==='deb'?(linuxArch==='x64'?'chatgpt_amd64.deb':'chatgpt_arm64.deb'):(linuxArch==='x64'?'chatgpt.x86_64.rpm':'chatgpt.aarch64.rpm');
    const work=await mkdtemp(join(tmpdir(),'rin-chatgpt-')),pkg=join(work,suffix);
    try{
      await download(CHATGPT_DOWNLOADS[linuxKind][linuxArch],pkg);
      const command=linuxKind==='deb'?'apt':'dnf';
      assertOk(await run('sudo',[command,'install','-y',pkg]),'ChatGPT installation');
    }finally{await rm(work,{recursive:true,force:true});}
    results.push({product,status:'installed',source:linuxKind});
  }
  return results;
}

export async function installHistoryTool({home,codexHome,platform=process.platform,arch=process.arch,libc,run=execCommand,download=downloadFile,exists=pathExists,verify=verifySha256,makeLink=symlink,codexCommand}={}){
  if(!home||!codexHome) throw new TypeError('home and codexHome are required');
  const asset=fffAsset({platform,arch,libc}),support=historySupport({platform,arch,libc}); if(!asset) throw new Error(support.reason);
  const tools=join(home,'tools'),binary=join(tools,platform==='win32'?'fff-mcp.exe':'fff-mcp');
  const root=join(home,'private','session-history'),logFile=join(home,'private','logs','fff.log');
  const args=[root,'--follow-symlinks','--no-update-check','--no-warmup','--log-file',logFile];
  const commandEnv={...process.env,CODEX_HOME:codexHome};
  const codex=typeof codexCommand==='string'?{command:codexCommand,args:[]}:codexCommand??await resolveCodex({platform,env:commandEnv});
  const current=await run(codex.command,[...codex.args,'mcp','get','session-history','--json'],{capture:true,allowFailure:true,env:commandEnv});
  let conflict = false;
  if(current.code===0){
    let parsed; try{parsed=JSON.parse(current.stdout);}catch{throw new Error('Could not inspect existing session-history MCP configuration');}
    const currentCommand=parsed.command??parsed.transport?.command,currentArgs=parsed.args??parsed.transport?.args??[];
    conflict = currentCommand!==binary||JSON.stringify(currentArgs)!==JSON.stringify(args);
  }else if(!/No MCP server named .* found/i.test(`${current.stdout||''}\n${current.stderr||''}`)) throw new Error(`Could not inspect existing session-history MCP configuration${current.stderr?`: ${current.stderr.trim()}`:''}`);
  await mkdir(tools,{recursive:true});
  if(!await exists(binary)){
    const work=await mkdtemp(join(tmpdir(),'rin-fff-')),candidate=join(work,'fff-mcp');
    try{
      await download(asset.url,candidate);
      await verify(candidate,asset.sha256);
      await copyFile(candidate,binary); if(platform!=='win32') await chmod(binary,0o755);
    }finally{await rm(work,{recursive:true,force:true});}
  }else await verify(binary,asset.sha256);
  await mkdir(root,{recursive:true}); await mkdir(join(home,'private','logs'),{recursive:true});
  if (conflict) return {status:'conflict',binary,registered:false};
  for(const name of ['sessions','archived_sessions']){
    const target=join(codexHome,name),destination=join(root,name);
    await mkdir(target,{recursive:true});
    try{
      const stat=await lstat(destination);
      if(!stat.isSymbolicLink()||resolve(dirname(destination),await readlink(destination))!==resolve(target)) throw new Error(`Session-history path already exists and points elsewhere: ${destination}`);
    }catch(error){if(error.code==='ENOENT') await makeLink(target,destination,platform==='win32'?'junction':'dir'); else throw error;}
  }
  if(current.code===0) return {status:'existing',binary,registered:true};
  assertOk(await run(codex.command,[...codex.args,'mcp','add','session-history','--',binary,...args],{env:commandEnv}),'Registering session-history MCP');
  return {status:'installed',binary,registered:true,version:FFF.version};
}

export const productSources=Object.freeze({chatgpt:CHATGPT_DOWNLOADS,fff:FFF});
