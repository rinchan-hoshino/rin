import type { CommandDescriptor, CommandContext, ChatCommand, ChatOutput, Logger } from './types.js';
// One command contract for text ingress and platform menus.
export const COMMANDS = Object.freeze([
  {name:'help',description:'Show available commands'},
  {name:'usage',description:'Show account usage',argument:'Options: daily, weekly, cumulative, text, --help'},
]);
export interface ParsedCommandText { commandLike: true; name: string; args: string; target?: string; registered: boolean; }

// Text that begins with a slash is not necessarily a registered command. Keep
// that distinction so unknown commands can never become ordinary chat prompts.
export function parseCommandText(text: unknown, commands: readonly CommandDescriptor[] = COMMANDS): ParsedCommandText | null {
  const source=String(text || '').trim();
  if(!source.startsWith('/'))return null;
  const match=/^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(source);
  if(!match || !match[1])return null;
  const at=match[1].indexOf('@');
  const name=(at<0?match[1]:match[1].slice(0,at)).toLowerCase();
  const target=at<0?'':match[1].slice(at+1).toLowerCase();
  return {commandLike:true,name,args:(match[2] || '').trim(),...(target?{target}:{}),registered:commands.some(command=>command.name===name)};
}

export function parseCommand(text: unknown, commands: readonly CommandDescriptor[] = COMMANDS, commandTarget?: 'self' | 'other') {
  const parsed=parseCommandText(text,commands);
  return parsed?.registered && (!parsed.target || commandTarget==='self') ? {name:parsed.name,args:parsed.args} : null;
}
export function builtinCommands(run: (name: string, context: CommandContext) => ChatOutput | Promise<ChatOutput>): ChatCommand[] {
  return COMMANDS.map(command=>({...command,run:context=>run(command.name,context)}));
}
export function commandHelp(commands: readonly CommandDescriptor[], privateChat: boolean) {
  return commands.filter(command=>privateChat || !command.privateOnly)
    .map(command=>`/${command.name} — ${command.description}`).join('\n')
    + (!privateChat && commands.some(command=>command.privateOnly)?'\n私聊可查看更多命令。':'');
}

// Menu synchronization is auxiliary: a slow platform must not hold daemon readiness.
export async function registerCommands(task: () => unknown | Promise<unknown>, log: Logger | undefined, label: string, timeoutMs = 2000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work=Promise.resolve().then(task).catch(()=>log?.warn?.(label));
  try { await Promise.race([work,new Promise(resolve=>{timer=setTimeout(resolve,timeoutMs);})]); }
  finally {clearTimeout(timer);}
}
