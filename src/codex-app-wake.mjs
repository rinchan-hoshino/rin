import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Use the App's own thread URL handler; never open a second execution backend.
export async function wakeCodexApp(threadId) {
  if (process.platform !== 'darwin') throw new Error('Codex App wake currently supports macOS only');
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)) throw new Error('Invalid thread ID for App wake');
  await run('/usr/bin/open', ['-g', `codex://threads/${threadId}`], { timeout: 10_000 });
}
