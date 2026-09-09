export interface NerveTarget {type:'command'|'http';argv?:string[];url?:string;receipt?:boolean;idempotent?:boolean;timeoutMs?:number;maxBytes?:number;maxAttempts?:number;tokenEnv?:string;cwd?:string}
export interface NerveConfig {targets:Record<string,NerveTarget>;database:string;cwd?:string;port?:number;scriptsDirectory?:string}
export interface NerveEvent {id:string;target:string;payload:string;state:string;attempts:number;available:number;created:number;updated:number;error:string|null;result:string|null;source:string|null}
