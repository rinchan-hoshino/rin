import type {NerveConfig} from './nerve-types.js';
import {isAbsolute} from 'node:path';
export type {NerveConfig} from './nerve-types.js';
export function validateTaskId(value:unknown):asserts value is string {
  if(typeof value!=='string' || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value))throw new Error('Existing task UUID required');
}
export function validateConfig(value:unknown):asserts value is NerveConfig{
  if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('Configuration must be an object');
  const config=value as NerveConfig;
  const fields=new Set(['targets','database','cwd','port','scriptsDirectory']);
  for(const field of Object.keys(config))if(!fields.has(field))throw new Error(`Unsupported configuration field ${field}; migrate producer configuration before upgrading`);
  if(!config.targets || typeof config.targets!=='object' || Array.isArray(config.targets))throw new Error('targets required');
  for(const [name,target] of Object.entries(config.targets)){
    if(!target || !['command','http'].includes(target.type))throw new Error(`Unknown target type: ${name}`);
    if(target.type==='command' && (!Array.isArray(target.argv) || !target.argv.length || target.argv.some(part=>typeof part!=='string' || !part)))throw new Error(`argv required: ${name}`);
    if(target.type==='http' && !/^https?:\/\//.test(target.url || ''))throw new Error(`Invalid URL: ${name}`);
    for(const key of ['timeoutMs','maxBytes','maxAttempts'] as const)if(target[key]!==undefined && (!Number.isSafeInteger(target[key]) || target[key]!<=0))throw new Error(`Invalid ${key}`);
    for(const key of ['idempotent','receipt'] as const)if(target[key]!==undefined && typeof target[key]!=='boolean')throw new Error(`Invalid ${key}`);
    if(target.receipt && target.type!=='command')throw new Error('receipt requires a command target');
    if(target.taskRouting!==undefined){
      const route=target.taskRouting;
      if(target.type!=='command' || !route || typeof route!=='object' || Array.isArray(route))throw new Error('taskRouting requires a command target');
      for(const field of Object.keys(route))if(!['defaultThreadId','codexHome','endpoint'].includes(field))throw new Error(`Unsupported taskRouting field ${field}`);
      validateTaskId(route.defaultThreadId);
      if(route.codexHome!==undefined && (typeof route.codexHome!=='string' || !isAbsolute(route.codexHome)))throw new Error('taskRouting.codexHome must be absolute');
      if(route.endpoint!==undefined && (typeof route.endpoint!=='string' || !/^(unix:\/\/|wss?:\/\/)/.test(route.endpoint)))throw new Error('Invalid taskRouting.endpoint');
    }
  }
  if(config.port!==undefined && (!Number.isSafeInteger(config.port)||config.port<0||config.port>65535))throw new Error('Invalid port');
  if(config.scriptsDirectory!==undefined && (typeof config.scriptsDirectory!=='string'||!config.scriptsDirectory))throw new Error('Invalid scriptsDirectory');
}
