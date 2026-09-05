import { readFile, rename, copyFile, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { exists, run } from './core.mjs';

const present = async file => { try { await lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const normalized = (value, platform) => platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value;
async function recordAt(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw new Error(`Cannot inspect the old Rin installation record: ${file}`); }
}

// Paths and fields follow legacy/pi paths.ts, persist.ts and fs-utils.ts.
export async function inspectLegacy({ userHome = homedir(), env = process.env, platform = process.platform, binDir = join(userHome, '.local/bin') } = {}) {
  const locator = join(userHome, '.rin/installer.json');
  const config = platform === 'win32' ? 'AppData/Roaming/rin' : platform === 'darwin' ? 'Library/Application Support/rin' : '.config/rin';
  const metadata = join(userHome, config, 'install.json');
  const manifest = await recordAt(locator), launcher = await recordAt(metadata);
  const record = manifest || launcher;
  const rootValue = record?.installDir || record?.defaultInstallDir || join(userHome, '.rin');
  if (typeof rootValue !== 'string' || !isAbsolute(rootValue)) throw new Error('The legacy installation directory must be absolute');
  const root = resolve(rootValue);
  const installedManifest = root === join(userHome, '.rin') ? manifest : await recordAt(join(root, 'installer.json'));
  if (!record && !installedManifest && !await exists(join(root, 'app/current'))) return null;
  const records = [];
  for (const file of new Set([locator, metadata, join(root, 'installer.json')])) if (await exists(file)) records.push(file);
  let service = installedManifest?.service || manifest?.service;
  const targetUser = installedManifest?.targetUser || record?.targetUser || record?.defaultTargetUser;
  if (!service && typeof targetUser === 'string' && targetUser) {
    const label = platform === 'darwin' ? `com.rin.daemon.${targetUser.trim().replace(/[^A-Za-z0-9_.-]+/g, '-')}` : `rin-daemon-${targetUser.trim().replace(/[^A-Za-z0-9_.@-]+/g, '-')}.service`;
    const servicePath = platform === 'win32' ? join(userHome, 'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/Rin Daemon.cmd') : platform === 'darwin' ? join(userHome, 'Library/LaunchAgents', `${label}.plist`) : join(userHome, '.config/systemd/user', label);
    if (await exists(servicePath)) {
      const text = normalized(await readFile(servicePath, 'utf8'), platform);
      if (text.includes(normalized(root, platform)) && /RIN_DIR/i.test(text) && /rin-daemon|dist[\\/]daemon\.js/i.test(text)) service = { kind: platform === 'win32' ? 'windows-startup' : platform === 'darwin' ? 'launchd' : 'systemd', label, servicePath };
    }
  }
  const cli = [];
  const names = platform === 'win32' ? ['rin.cmd', 'rin-install.cmd', 'rin.ps1', 'rin'] : ['rin', 'rin-install'];
  for (const directory of new Set([binDir, join(userHome, '.local/bin'), ...(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':')].filter(Boolean).map(path => resolve(path)))) {
    for (const name of names) {
      const file = join(directory, name);
      try {
        const text = normalized((await readFile(file, 'utf8')).slice(0, 65536), platform);
        const entries = name.startsWith('rin-install') ? ['app/rin-install/main.js'] : ['app/rin/main.js', 'index.js'];
        // Match an executable's quoted entry, not merely a mention of .rin in arbitrary code.
        if (entries.some(entry => {
          const path = normalized(join(root, 'app/current/dist', entry), platform);
          return (text.includes(`'${path}'`) || text.includes(`"${path}"`)) && (platform === 'win32' ? /^@echo off/im.test(text) && text.includes('%*') : /^#!/m.test(text) && /\bexec\s/.test(text) && text.includes('"$@"'));
        })) cli.push(file);
      } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'EISDIR') throw e; }
    }
  }
  return { root, service, cli, records };
}

export async function disableLegacy(legacy, { exec = run, platform = process.platform, uid = process.getuid?.() } = {}) {
  if (!legacy) return;
  const service = legacy.service;
  const startup = service?.kind === 'windows-startup' ? service.path || service.servicePath : null;
  const backups = [...new Set([...(legacy.cli || []), ...(legacy.records || []), ...(startup ? [startup] : [])])];
  // Preflight every backup before stopping any service; lstat also detects dangling links.
  for (const file of backups) if (await present(`${file}.pi-disabled`)) throw new Error(`A disabled legacy backup already exists: ${file}.pi-disabled`);
  if (service?.kind === 'launchd') {
    if (!/^com\.rin\.daemon\.[a-zA-Z0-9_.-]+$/.test(service.label)) throw new Error('Unrecognized legacy service label; inspect it before migration');
    const target = `gui/${uid}/${service.label}`;
    await exec('launchctl', ['disable', target]);
    const status = await exec('launchctl', ['print', target], { capture: true, allowFailure: true });
    if (status.code === 0) await exec('launchctl', ['bootout', target]);
  } else if (service?.kind === 'systemd') {
    const unit = service.label || service.unit || service.name;
    if (!/^rin-daemon-[a-zA-Z0-9_.@-]+\.service$/.test(unit || '')) throw new Error('Unrecognized legacy systemd unit; inspect it before migration');
    await exec('systemctl', ['--user', 'disable', '--now', unit]);
  } else if (service?.kind === 'windows-startup' && platform === 'win32') {
    if (!startup || !/[\\/]Rin Daemon\.cmd$/.test(startup)) throw new Error('Unrecognized legacy startup launcher');
    const node = join(legacy.root, 'runtime/node/current/node.exe');
    let entry;
    for (const candidate of ['app/rin/main.js', 'index.js']) if (await exists(join(legacy.root, 'app/current/dist', candidate))) { entry = join(legacy.root, 'app/current/dist', candidate); break; }
    if (!await exists(node) || !entry) throw new Error('The legacy Windows CLI is missing; stop its daemon before continuing');
    await exec(node, [entry, 'stop'], { env: { ...process.env, RIN_DIR: legacy.root } });
    if (await present(startup)) await rename(startup, `${startup}.pi-disabled`);
  } else throw new Error('The legacy service record is missing or unsupported. Inspect its shutdown and autostart before retrying.');
  for (const file of legacy.records || []) await copyFile(file, `${file}.pi-disabled`, constants.COPYFILE_EXCL);
  for (const file of legacy.cli) await rename(file, `${file}.pi-disabled`);
}
