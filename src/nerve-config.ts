import type {NerveConfig} from './nerve-types.js';
export type {NerveConfig} from './nerve-types.js';
export function validateConfig(value:unknown):asserts value is NerveConfig{
  if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('Configuration must be an object');
  const config=value as NerveConfig;
  // Validate only the fields this runtime consumes. Producer configuration
  // belongs to its owner and does not impose an installation migration gate.
  if(!config.targets || typeof config.targets!=='object' || Array.isArray(config.targets))throw new Error('targets required');
  for(const [name,target] of Object.entries(config.targets)){
    if(!target || !['command','http'].includes(target.type))throw new Error(`Unknown target type: ${name}`);
    if(target.type==='command' && (!Array.isArray(target.argv) || !target.argv.length || target.argv.some(part=>typeof part!=='string' || !part)))throw new Error(`argv required: ${name}`);
    if(target.type==='http' && !/^https?:\/\//.test(target.url || ''))throw new Error(`Invalid URL: ${name}`);
    for(const key of ['timeoutMs','maxBytes','maxAttempts'] as const)if(target[key]!==undefined && (!Number.isSafeInteger(target[key]) || target[key]!<=0))throw new Error(`Invalid ${key}`);
    for(const key of ['idempotent','receipt'] as const)if(target[key]!==undefined && typeof target[key]!=='boolean')throw new Error(`Invalid ${key}`);
    if(target.receipt && target.type!=='command')throw new Error('receipt requires a command target');
    if('taskRouting' in target)throw new Error('taskRouting was removed; route agent work through an explicit command or HTTP target');
  }
  if(config.port!==undefined && (!Number.isSafeInteger(config.port)||config.port<0||config.port>65535))throw new Error('Invalid port');
  if(config.scriptsDirectory!==undefined && (typeof config.scriptsDirectory!=='string'||!config.scriptsDirectory))throw new Error('Invalid scriptsDirectory');
}
