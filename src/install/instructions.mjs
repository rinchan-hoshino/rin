import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {exists} from './core.mjs';

export const RIN_SUBAGENT_INSTRUCTIONS = 'Make active use of subagents: use Astra for work that can run in parallel, Terra for relatively independent, simple tasks, and Luna for purely execution-oriented tasks.';

export async function appendAgentsInstructions(file, {agents = '', subagentGuidance = false} = {}) {
  const previous = await exists(file) ? await readFile(file, 'utf8') : '';
  let next = previous;
  const append = text => { next += `${next && !next.endsWith('\n') ? '\n' : ''}${next ? '\n' : ''}${text}\n`; };
  if (agents.trim()) append(agents);
  if (subagentGuidance && !next.includes(RIN_SUBAGENT_INSTRUCTIONS)) append(RIN_SUBAGENT_INSTRUCTIONS);
  if (next === previous) return false;
  await mkdir(dirname(file), {recursive: true});
  await writeFile(file, next, {mode: 0o600});
  return true;
}
