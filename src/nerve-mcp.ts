interface PropertySchema {type:string; minLength?:number;description?:string;minimum?:number;pattern?:string;enum?:string[];minItems?:number;items?:PropertySchema}
interface InputSchema {type:string;properties:Record<string,PropertySchema>;required:string[];additionalProperties:boolean}
interface ToolArgs extends Record<string,unknown> {id?:string;messageId?:string;at?:string;timeZone?:string}
interface RpcRequest {jsonrpc?:string;id?:string|number|null;method?:string;params?:{name?:string;arguments?:ToolArgs}}
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const string = { type: 'string', minLength: 1 };
const boolean = { type: 'boolean' };
const id = { ...string, description: 'Stable caller-chosen identifier; reuse it to prevent duplicate work.' };
const target = { ...string, description: 'Existing configured Nerve target ID. Cannot define an output command.' };
const source = {...string,description:'Stable producer ID supplied by the event producer, such as a trigger ID. Routing never comes from payload.'};
const threadId = {...string,pattern:'^[\\da-fA-F]{8}-[\\da-fA-F]{4}-[\\da-fA-F]{4}-[\\da-fA-F]{4}-[\\da-fA-F]{12}$',description:'Existing unarchived Codex task UUID. Omit to restore this target default.'};
const schema = (properties: Record<string,PropertySchema> = {}, required: string[] = []): InputSchema => ({ type: 'object', properties, required, additionalProperties: false });
const definitions: [string,string,InputSchema,boolean][] = [
  ['nerve_status', 'Check the local Nerve service health.', schema(), true],
  ['nerve_list_events', 'Read recent event states; use nerve_get_event for full results.', schema(), true],
  ['nerve_get_event', 'Read an event and its result by stable event ID. Done means the configured target accepted delivery, not that an agent completed its work.', schema({ id }, ['id']), true],
  ['nerve_enqueue_event', 'Queue one event for a configured target. Reuse a stable ID with the same source and payload to deduplicate. Task routing is snapshotted at first enqueue; retries never migrate to a later binding.', schema({ id, target, source, payload: { type: 'object' } }, ['id', 'target', 'payload']), false],
  ['nerve_retry_event', 'Retry a failed or uncertain event after checking its current result and external effects. An uncertain event may have already acted; retry can duplicate side effects.', schema({ id }, ['id']), false],
  ['nerve_list_task_bindings','Read configured default tasks and persisted target/source task bindings.',schema(),true],
  ['nerve_bind_task','Bind a producer source to an existing task, or omit threadId to restore the configured default. Only affects future events. Requires a target with taskRouting configured.',schema({target,source,threadId},['target','source']),false],
  ['nerve_create_task','Explicitly create a native Codex task and bind this producer source. No model turn is started. Reuse the creation ID; pending or uncertain results never create again. Inspect nerve_get_task_creation before recovery.',schema({id,target,source,cwd:{...string,description:'Existing absolute working directory for the new task.'},name:{...string,description:'Optional task title.'}},['id','target','source','cwd']),false],
  ['nerve_get_task_creation','Read a task creation receipt, including any known task ID when creation or binding is incomplete. Never delete an existing user task to recover.',schema({id},['id']),true],
];

export const toolDefinitions = definitions.map(([name, description, inputSchema, readOnlyHint]) => ({
  name, description, inputSchema,
  annotations:{readOnlyHint,destructiveHint:!readOnlyHint,idempotentHint:readOnlyHint || ['nerve_enqueue_event','nerve_bind_task','nerve_create_task'].includes(name),openWorldHint:!readOnlyHint},
}));

function validate(args: Record<string,unknown>, spec: InputSchema) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object');
  for (const field of Object.keys(args)) if (!(field in spec.properties)) throw new Error(`Unknown argument: ${field}`);
  for (const field of spec.required) if (!(field in args)) throw new Error(`Missing argument: ${field}`);
  for (const [key, value] of Object.entries(args)) {
    const type = spec.properties[key].type;
    if (type === 'array' ? !Array.isArray(value) : type === 'object' ? !value || typeof value !== 'object' || Array.isArray(value) : typeof value !== type) throw new Error(`Invalid argument: ${key}`);
    if (type === 'string' && typeof value === 'string' && (!value.length || (spec.properties[key].pattern && !new RegExp(spec.properties[key].pattern!).test(value)) || spec.properties[key].enum && !spec.properties[key].enum.includes(value))) throw new Error(`Invalid argument: ${key}`);
    if (type === 'number' && typeof value === 'number' && (!Number.isFinite(value) || value < spec.properties[key].minimum!)) throw new Error(`Invalid argument: ${key}`);
    if (type === 'array' && Array.isArray(value) && (!value.length || value.some(item => typeof item !== 'string' || !item.length))) throw new Error(`Invalid argument: ${key}`);
  }
}

export function createHandler({ port, token, requestTimeoutMs = 15000 }: {port:number;token:string;requestTimeoutMs?:number}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Nerve port');
  if (typeof token !== 'string' || token.length < 24) throw new Error('Missing or invalid Nerve token');
  async function request(method: string, path: string, body?: unknown) {
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(requestTimeoutMs),
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new Error('Local Nerve is unavailable or timed out'); }
    const text = await response.text();
    if (!response.ok) {
      // Do not forward arbitrary backend diagnostics, prompts, or credentials on errors.
      throw new Error(`Nerve HTTP ${response.status}; inspect service state before retrying`);
    }
    if (!text.trim()) return { ok: true };
    try { return JSON.parse(text); } catch { throw new Error('Nerve returned invalid JSON'); }
  }
  return async function handle(message: RpcRequest) {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
    }
    if (!Object.hasOwn(message, 'id')) return null;
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id: message.id, result });
    const error = (code: number, text: string) => ({ jsonrpc: '2.0', id: message.id, error: { code, message: text } });
    if (message.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'nerve', version: '1.3.0' }, instructions: 'Nerve delivers generic events to configured targets. Done records target acceptance only. Explicit task setup does not start a model turn. Use stable IDs; investigate uncertain outcomes before retrying.' });
    if (message.method === 'ping') return reply({});
    if (message.method === 'tools/list') return reply({ tools: toolDefinitions });
    if (message.method !== 'tools/call') return error(-32601, 'Method not found');
    const name = message.params?.name;
    const tool = toolDefinitions.find(tool => tool.name === name);
    if (!tool) return error(-32602, 'Unknown tool');
    const args = message.params?.arguments ?? {};
    try {
      validate(args, tool.inputSchema);
      if (args.id === '.' || args.id === '..') throw new Error('ID cannot be a path traversal segment');

    } catch (cause) { return error(-32602, (cause as Error).message); }
    const encoded = encodeURIComponent(args.id ?? '');
    const routes: Record<string,[string,string,unknown?]> = {
      nerve_status:['GET','/health'],
      nerve_list_events: ['GET', '/events'], nerve_get_event: ['GET', `/events/${encoded}`],
      nerve_enqueue_event: ['POST', '/events', args], nerve_retry_event: ['POST', `/events/${encoded}/retry`, {}],
      nerve_list_task_bindings:['GET','/task-bindings'],nerve_bind_task:['POST','/task-bindings',args],
      nerve_create_task:['POST','/task-bindings/create',args],nerve_get_task_creation:['GET',`/task-creations/${encoded}`],
    };
    try {
      const value = await request(...routes[name!]);
      return reply({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: name==='nerve_create_task' && value.state!=='bound' });
    } catch (cause) { return reply({ content: [{ type: 'text', text: (cause as Error).message }], isError: true }); }
  };
}

export async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const configPath = resolve(process.env.NERVE_CONFIG ?? resolve(root, 'private/nerve.json'));
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const secrets = JSON.parse(await readFile(resolve(dirname(configPath), 'secrets.json'), 'utf8'));
  const handle = createHandler({ port: config.port ?? 9761, token: secrets.NERVE_TOKEN });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let response;
    try { response = await handle(JSON.parse(line)); }
    catch { response = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }; }
    if (response) process.stdout.write(JSON.stringify(response) + '\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('Nerve MCP failed to start; check private configuration and credentials.\n'); process.exitCode = 1; });
}
