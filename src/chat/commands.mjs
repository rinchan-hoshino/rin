// One command contract for text ingress and platform menus.
export const COMMANDS = Object.freeze([
  {name:'help',description:'Show available commands'},
  {name:'usage',description:'Show account usage in a private chat',argument:'Options: current, history, card, text, --help'},
  {name:'bind',description:'Connect this chat to an existing task',argument:'Task UUID'},
  {name:'status',description:'Show this chat connection status'},
  {name:'unbind',description:'Disconnect this chat'},
]);
export function parseCommand(text) {
  const match=/^\/([a-z]+)(?:@[\w]+)?(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  return match && COMMANDS.some(c=>c.name===match[1]) ? {name:match[1],args:(match[2] || '').trim()} : null;
}
export function commandOwner(config,userId) {
  // A multi-user chat allowlist is not an administrative role assignment.
  const owners=config.ownerUsers ?? (config.allowUsers?.length===1 ? config.allowUsers : []);
  return Array.isArray(owners) && owners.includes(String(userId));
}
export function commandHelp(privateChat) {
  return '/help — 查看命令\n/status — 查看连接状态\n/usage — 在私聊查看用量\n/bind — 连接已有任务（主人）\n/unbind — 解除连接（主人）' + (privateChat?'\n用量选项：/usage --help':'');
}

// Menu synchronization is auxiliary: a slow platform must not hold daemon readiness.
export async function registerCommands(task, log, label, timeoutMs = 2000) {
  let timer;
  const work=Promise.resolve().then(task).catch(()=>log?.warn?.(label));
  try { await Promise.race([work,new Promise(resolve=>{timer=setTimeout(resolve,timeoutMs);})]); }
  finally {clearTimeout(timer);}
}
