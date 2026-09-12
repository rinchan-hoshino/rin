import type { CodexAppServer } from '../codex-app-server.js';

/** Creation and submission use the same operator-managed shared server. */
export async function createCodexThread({server, cwd, model, name}: {server: CodexAppServer; cwd: string; model?: string; name?: string}) {
  let sent = false;
  let threadId: string | undefined;
  try {
    await server.connect();
    sent = true;
    const result = await server.request<{thread?: {id?: string}}>('thread/start', {cwd, ...(model ? {model} : {})});
    const id = result?.thread?.id;
    if (!id) throw new Error('Codex thread creation returned no thread ID');
    // Persist an empty routing task without running a model turn.
    await server.request('thread/inject_items', {threadId: id, items: [{type: 'message', role: 'developer', content: [{type: 'input_text', text:
      'This task receives messages through the Rin chat bridge. Ordinary assistant replies are automatically delivered to the bound chat; do not send a second copy with external messaging tools.',
    }]}]});
    threadId = id;
    if (name) await server.request('thread/name/set', {threadId, name});
    return threadId;
  } catch (cause) {
    const error = cause as Error & {code?: string; threadId?: string};
    error.code = sent ? 'CODEX_THREAD_CREATE_UNCERTAIN' : 'CODEX_THREAD_CREATE_FAILED';
    if (threadId) error.threadId = threadId;
    throw error;
  }
}
