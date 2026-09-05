import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {exists} from './core.mjs';

export const RIN_SUBAGENT_INSTRUCTIONS = `## Rin subagent guidance

Choose subagent models from those currently available in the host, using their stated capabilities and relative cost. Use lower-cost models for bounded, straightforward work; reserve more capable models for difficult reasoning, uncertain requirements, and integration decisions. Do not assume model names or prices remain current.

Delegate concrete, independent tasks in parallel when the expected benefit exceeds coordination and context costs. Keep dependent steps sequential, avoid concurrent edits to the same files, and do small tasks locally when delegation adds overhead. Give each subagent only the context and acceptance criteria it needs. Follow the host's available tools and model-selection rules; if a model override is unavailable, use the supported default.

The primary agent owns the outcome: review and integrate subagent results, resolve conflicts, and verify the combined change before reporting completion.`;

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

