import type {AgentConfig} from './types.js';

export const agentExecutables = {codex:'codex','claude-code':'claude',pi:'pi',opencode:'opencode'};

/** The interactive launcher and chat adapters share the configured executable. */
export function agentCommand(config: AgentConfig) {
  if(config.type==='codex') {
    const [command,...args]=config.command || [agentExecutables.codex];
    return {command,args,env:{...process.env,...(config.codexHome ? {CODEX_HOME:config.codexHome} : {})}};
  }
  return {command:config.command || agentExecutables[config.type],args:config.extraArgs || [],
    cwd:config.cwd,env:{...process.env,...config.env}};
}
