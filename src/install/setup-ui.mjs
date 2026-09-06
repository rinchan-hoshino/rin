import * as clack from '@clack/prompts';
import {readFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {RIN_SUBAGENT_INSTRUCTIONS} from './instructions.mjs';

export const setupUI = clack;

function checked(value, ui) {
  if (ui.isCancel(value)) {
    ui.cancel('Installation cancelled.');
    throw Object.assign(new Error('Installation cancelled'), {code: 'INSTALL_CANCELLED'});
  }
  return value;
}
export async function confirmChoice(message, initialValue = false, ui = clack) {
  return checked(await ui.confirm({message,initialValue}), ui);
}

function note(ui, body, title) {
  const width = Math.max(32, Math.min(72, (process.stdout.columns || 80) - 8));
  const lines = String(body).split('\n').flatMap(line => {
    const rows = []; let row = '';
    for (const word of line.split(' ')) {
      if (row && row.length + word.length + 1 > width) { rows.push(row); row = ''; }
      row += `${row ? ' ' : ''}${word}`;
    }
    return [...rows,row];
  });
  ui.note(lines.join('\n'),title);
}

async function promptInstructions(ui) {
  const mode = checked(await ui.select({message:'Personal AGENTS instructions', options:[
    {value:'text',label:'Write a paragraph here'},
    {value:'file',label:'Read a Markdown file',hint:'for multiline instructions'},
    {value:'skip',label:'Skip'},
  ]}),ui);
  if (mode === 'skip') return '';
  if (mode === 'text') return checked(await ui.text({message:'Your instructions (leave empty to skip)',defaultValue:''}),ui);
  for (;;) {
    const file = checked(await ui.text({message:'Path to your UTF-8 Markdown file',validate:value=>!String(value || '').trim()?'Enter a file path.':undefined}),ui);
    try {
      const path = resolve(file.trim());
      if (!(await stat(path)).isFile()) throw new Error('not a file');
      return await readFile(path,'utf8');
    } catch { ui.log.error('Cannot read that file. Enter the path again, or press Ctrl+C to cancel.'); }
  }
}

export async function collectChoices({hasAgents = false, legacy = null, home, agentsPath, ui = clack} = {}) {
  ui.intro('Rin for Codex — Git installation');
  note(ui,'Install the Codex-based Rin independently. Old data is retained, not imported. Chat and background work stay stopped until configured.','Before you begin');
  if (legacy) {
    note(ui,'An old Pi-based Rin installation was found. Continuing will disable its recognized service and CLI launchers. Its private data will be retained.','Legacy replacement');
    if (!await confirmChoice('Continue with the old Rin cutover?',false,ui)) { ui.outro('Nothing installed.'); return null; }
  }
  const products = checked(await ui.multiselect({message:'Products to install', options:[
    {value:'codex',label:'Codex CLI'},
    {value:'chatgpt',label:'ChatGPT desktop app'},
  ],required:false,initialValues:[]}),ui);
  note(ui,'Enables context management and memories; limits each tool output stored in history to 4,000 tokens; grants full filesystem access and sets approval_policy=never. Prevents sleep during work and keeps remote control awake while plugged in. Uses an empty Git branch prefix, squash merges and best-effort worktree refresh. Disables Sites, Hotline and Safety Settings connectors. Other settings are preserved.','Recommended Codex profile');
  const recommendations = await confirmChoice('Apply the Rin recommended Codex profile?',false,ui);
  if (!recommendations) ui.log.info('Existing Codex settings will be preserved.');
  let agents = '';
  if (!hasAgents || await confirmChoice('Global AGENTS.md already exists. Append personal instructions?',false,ui)) agents = await promptInstructions(ui);
  note(ui,RIN_SUBAGENT_INSTRUCTIONS,'Optional subagent guidance');
  const subagentGuidance = await confirmChoice('Append Rin subagent guidance after your instructions?',false,ui);
  note(ui,[
    home ? `Install location: ${home}` : 'Install for the current user.',
    `Products: ${products.length ? products.join(', ') : 'use existing products'}`,
    `Recommended profile: ${recommendations ? 'apply, including full access and approval_policy=never' : 'preserve current settings'}`,
    `Personal instructions: ${agents ? 'append supplied text' : 'preserve current text'}`,
    `Subagent guidance: ${subagentGuidance ? 'append if not already present' : 'skip'}`,
    agentsPath ? `Instructions file: ${agentsPath}` : '',
    'Original-session search: included (FFF MCP)',
  ].filter(Boolean).join('\n'),'Installation plan');
  if (!await confirmChoice('Install Rin with these choices?',true,ui)) { ui.outro('Finished without installing Rin.'); return null; }
  return {products,recommendations,agents,subagentGuidance};
}

export async function runSetupProgress(message, action, {ui = clack, tty = process.stderr.isTTY} = {}) {
  if (!tty) return action();
  const progress = ui.spinner();
  progress.start(message);
  try { const result = await action(); progress.stop(message); return result; }
  catch (error) { progress.stop(`${message} failed`,1); throw error; }
}
