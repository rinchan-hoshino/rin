// One command contract for text ingress and platform menus.
export const COMMANDS = Object.freeze([
  {name:'help',description:'Show available commands'},
  {name:'usage',description:'Show account usage',argument:'Options: current, history, card, text, --help'},
]);
export function parseCommand(text, commands = COMMANDS) {
  const match=/^\/([a-z][a-z0-9_]*)(?:@[\w]+)?(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  return match && commands.some(c=>c.name===match[1]) ? {name:match[1],args:(match[2] || '').trim()} : null;
}
export function builtinCommands(run) {
  return COMMANDS.map(command=>({...command,run:context=>run(command.name,context)}));
}
export function commandHelp(commands, privateChat) {
  return commands.filter(command=>privateChat || !command.privateOnly)
    .map(command=>`/${command.name} — ${command.description}`).join('\n')
    + (!privateChat && commands.some(command=>command.privateOnly)?'\n私聊可查看更多命令。':'');
}

// Menu synchronization is auxiliary: a slow platform must not hold daemon readiness.
export async function registerCommands(task, log, label, timeoutMs = 2000) {
  let timer;
  const work=Promise.resolve().then(task).catch(()=>log?.warn?.(label));
  try { await Promise.race([work,new Promise(resolve=>{timer=setTimeout(resolve,timeoutMs);})]); }
  finally {clearTimeout(timer);}
}
