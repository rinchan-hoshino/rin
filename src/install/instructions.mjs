import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {exists} from './core.mjs';

export const RIN_SUBAGENT_INSTRUCTIONS = 'Actively use a separate subagent for each independent subtask. For example, use Astra subagents for work that can run in parallel, and Luna subagents for simple tasks.';
export const RIN_LEGACY_SUBAGENT_INSTRUCTIONS = Object.freeze([
  'Make active use of subagents: use Astra for work that can run in parallel, Terra for relatively independent, simple tasks, and Luna for purely execution-oriented tasks.',
]);

function replaceLegacyGuidance(previous) {
  let next = previous;
  for (const legacy of RIN_LEGACY_SUBAGENT_INSTRUCTIONS) {
    const first = next.indexOf(legacy);
    if (first < 0) continue;
    next = next.replaceAll(legacy, '');
    if (!next.includes(RIN_SUBAGENT_INSTRUCTIONS)) {
      next = `${next.slice(0, first)}${RIN_SUBAGENT_INSTRUCTIONS}${next.slice(first)}`;
    }
  }
  return next;
}

export async function migrateAgentsInstructions(file) {
  if (!await exists(file)) return false;
  const previous = await readFile(file, 'utf8');
  const next = replaceLegacyGuidance(previous);
  if (next === previous) return false;
  await writeFile(file, next, {mode: 0o600});
  return true;
}

export async function appendAgentsInstructions(file, {agents = '', subagentGuidance = false} = {}) {
  const previous = await exists(file) ? await readFile(file, 'utf8') : '';
  let next = subagentGuidance ? replaceLegacyGuidance(previous) : previous;
  const append = text => { next += `${next && !next.endsWith('\n') ? '\n' : ''}${next ? '\n' : ''}${text}\n`; };
  if (agents.trim()) append(agents);
  if (subagentGuidance && !next.includes(RIN_SUBAGENT_INSTRUCTIONS)) append(RIN_SUBAGENT_INSTRUCTIONS);
  if (next === previous) return false;
  await mkdir(dirname(file), {recursive: true});
  await writeFile(file, next, {mode: 0o600});
  return true;
}
