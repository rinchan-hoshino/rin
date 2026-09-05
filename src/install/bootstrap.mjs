import {readFile} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {findNpmCli,run} from './core.mjs';

export async function prepareSetupDependencies(root, {exec = run} = {}) {
  const expected = JSON.parse(await readFile(join(root,'package.json'),'utf8')).dependencies['@clack/prompts'];
  let installed;
  try { installed = JSON.parse(await readFile(join(root,'node_modules/@clack/prompts/package.json'),'utf8')).version; } catch {}
  if (installed === expected) return;
  await exec(process.execPath,[await findNpmCli(),'ci','--ignore-scripts','--no-audit','--no-fund'],{cwd:root});
}

export async function bootstrap() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)),'../..');
  await prepareSetupDependencies(root);
  const {setup} = await import('./setup.mjs');
  await setup();
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) bootstrap().catch(error => {
  if (error.code !== 'INSTALL_CANCELLED') console.error(error.message);
  process.exitCode = 1;
});
