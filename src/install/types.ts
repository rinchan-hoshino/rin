import type {SpawnOptions} from 'node:child_process';

export interface Executable { command: string; args: string[] }
export interface ExecOptions extends SpawnOptions { capture?: boolean; allowFailure?: boolean }
export interface ExecResult { code: number | null; signal?: NodeJS.Signals | null; stdout: string; stderr: string }
export type Exec = (command: string,args: string[],options?: ExecOptions)=>Promise<ExecResult>;
export interface InstallState {
  schema: 1; type: 'git'; repository: string; current: string; previous?: string | null;
  node: string; serviceId?: string;
}
export type Candidate = {sha: string; changed: false} | {sha: string; release: string; changed: true};
export interface Service { install(): Promise<void>; start(): Promise<void>; stop(): Promise<void>; isRunning(): Promise<boolean> }
export type ManagedService = Pick<Service,'start'|'stop'|'isRunning'>;
export type JsonValue = string | number | boolean | null | JsonValue[] | {[key:string]:JsonValue};
export function errorCode(error: unknown): string | number | undefined {
  if (error && typeof error==='object' && 'code' in error && (typeof error.code==='string' || typeof error.code==='number')) return error.code;
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
