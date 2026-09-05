import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const NAME = /^[a-z][a-z0-9_]{0,12}$/;
const WARNING = 'Command extension ignored.';

function warn(log) {
  try { log?.warn?.(WARNING); } catch {}
}

function descriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.name !== 'string' || !NAME.test(value.name)) return null;
  const description = typeof value.description === 'string' ? value.description.trim() : '';
  const argument = typeof value.argument === 'string' ? value.argument.trim() : value.argument;
  if (description.length < 1 || description.length > 100) return null;
  if (argument !== undefined && (typeof argument !== 'string' || argument.length < 1 || argument.length > 100)) return null;
  if (value.privateOnly !== undefined && typeof value.privateOnly !== 'boolean') return null;
  if (typeof value.run !== 'function') return null;
  return {
    name: value.name,
    description,
    ...(argument === undefined ? {} : { argument }),
    ...(value.privateOnly === undefined ? {} : { privateOnly: value.privateOnly }),
    run: value.run,
  };
}

export async function loadCommandExtensions({ directory, reservedNames = [], log = console } = {}) {
  if (typeof directory !== 'string' || !directory) {
    warn(log);
    return [];
  }
  let entries;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    warn(log);
    return [];
  }
  const reserved = new Set(Array.isArray(reservedNames) ? reservedNames.filter(name => typeof name === 'string') : []);
  const loaded = [];
  for (const entry of entries.filter(entry => entry.isFile() && entry.name.endsWith('.mjs')).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const path = join(directory, entry.name);
      const metadata = await stat(path, { bigint: true });
      const url = pathToFileURL(path);
      url.searchParams.set('v', `${metadata.mtimeNs}-${metadata.size}`);
      const candidate = descriptor((await import(url.href)).default);
      if (!candidate || reserved.has(candidate.name)) warn(log);
      else loaded.push(candidate);
    } catch {
      warn(log);
    }
  }
  const counts = new Map();
  for (const item of loaded) counts.set(item.name, (counts.get(item.name) || 0) + 1);
  const duplicates = new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
  if (duplicates.size) for (const item of loaded) if (duplicates.has(item.name)) warn(log);
  return loaded.filter(item => !duplicates.has(item.name));
}
