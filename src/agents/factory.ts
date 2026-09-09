import type {AgentBridge,AgentConfig} from './types.js';
import {CliAgentBridge} from './cli.js';
import {CodexBridge} from '../chat/codex.js';

export function createAgentBridge(config: AgentConfig): AgentBridge {
  if(!config || typeof config!=='object')throw new Error('agent configuration is required');
  if(config.type==='codex')return new CodexBridge(config);
  if(['claude-code','pi','opencode'].includes(config.type))return new CliAgentBridge(config);
  throw new Error(`Unsupported agent type: ${String((config as {type?:unknown}).type)}`);
}
