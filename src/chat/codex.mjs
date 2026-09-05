import { CodexAppIpc } from '../codex-app-ipc.mjs';
import { wakeCodexApp } from '../codex-app-wake.mjs';
import { CodexQueue } from '../codex-queue.mjs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { homedir } from 'node:os';

const REQUIRED_HISTORY_COLUMNS = {
  thread_turns: ['thread_id', 'turn_id', 'rollout_ordinal', 'status', 'error_json', 'started_at', 'completed_at'],
  thread_items: ['thread_id', 'turn_id', 'item_id', 'rollout_ordinal', 'created_at_ms', 'item_json', 'item_type', 'updated_at_ordinal'],
};
function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} required`);
  return value.trim();
}

function visibleItem(row) {
  if (row.item_type === 'agentMessage' && typeof row.agent_text === 'string') {
    // Async user questions are projected as final_answer even while the turn
    // keeps running. They are independent messages, not a terminal answer.
    if (row.agent_delivery === 'async' || row.has_questions) return { text: row.agent_text, phase: 'question' };
    const phase = !row.agent_phase || row.agent_phase === 'final_answer' ? 'final' : row.agent_phase;
    return { text: row.agent_text, phase };
  }
  if (row.item_type === 'reasoning' && typeof row.summary_json === 'string') {
    let summary;
    try { summary = JSON.parse(row.summary_json); } catch { return null; }
    if (Array.isArray(summary) && summary.every(part => typeof part === 'string')) {
      return { text: summary.filter(part=>part.trim()).at(-1) || '', phase: 'summary' };
    }
  }
  return null;
}

/**
 * Thin bridge to an existing Codex App thread.
 *
 * Optional App IPC submits input and can load an unowned task through its App URL. Until the desktop
 * shared daemon exposes a working subscriber handshake, watch() uses a pinned,
 * read-only observer for the 0.153.x paginated history schema. It never starts
 * a second app-server or takes ownership of the thread.
 */
export class CodexBridge extends CodexQueue {
  constructor({ command = ['codex'], codexHome = join(homedir(), '.codex'), onEvent = () => {}, getCursor, setCursor, pollMs = 500, queueTimeoutMs = 30_000, appSteering = false, appWake = false, wakeApp = wakeCodexApp } = {}) {
    super({ command, codexHome, queueTimeoutMs });
    if (typeof onEvent !== 'function') throw new Error('onEvent function required');
    if (!Number.isFinite(pollMs) || pollMs < 10) throw new Error('pollMs must be at least 10');
    this.onEvent = onEvent;
    this.getCursor = getCursor;
    this.setCursor = setCursor;
    this.pollMs = pollMs;
    this.watchers = new Map();
    if (typeof appSteering !== 'boolean') throw new Error('appSteering must be boolean');
    this.appIpc = appSteering ? new CodexAppIpc({ codexHome: this.codexHome, timeoutMs: queueTimeoutMs }) : null;
    if (typeof appWake !== 'boolean' || typeof wakeApp !== 'function') throw new Error('Invalid App wake configuration');
    if (appWake && !appSteering) throw new Error('appWake requires appSteering');
    this.wakeApp = appWake ? wakeApp : null;
    this.wakeTimeoutMs = queueTimeoutMs;
  }

  async queue(threadId, input = {}) {
    if (!this.started) throw new Error('CodexBridge not started');
    const files = input.files || [];
    if (!Array.isArray(files)) throw new Error('files must be an array');
    if (this.appIpc) {
      let context = this.threadContext(threadId);
      if (!context && this.wakeApp) throw new Error('Codex task context unavailable; message was not queued');
      if (context) {
        const receipt = await this.appIpc.steer(threadId, {
          text: input.text, files, cwd: context.cwd, start: !context.active,
        });
        if (receipt) return receipt;
        if (this.wakeApp) {
          await this.wakeApp(threadId);
          const deadline = Date.now() + this.wakeTimeoutMs;
          while (this.started && Date.now() < deadline) {
            // Loading can change the active turn. Re-read before each submission.
            context = this.threadContext(threadId);
            if (!context) throw new Error('Codex task unavailable after App wake');
            const resumed = await this.appIpc.steer(threadId, {
              text: input.text, files, cwd: context.cwd, start: !context.active,
            });
            if (resumed) return resumed;
            // null means no business input was sent. Errors, including ambiguous
            // receipts, propagate without replay or a second queue submission.
            await new Promise(resolve => setTimeout(resolve, 250));
          }
          throw new Error('Codex App did not load the task before wake timed out; message was not queued');
        }
      }
    }
    return super.queue(threadId, input);
  }

  activeThread(threadId) {
    const context = this.threadContext(threadId);
    return context?.active ? {cwd:context.cwd} : null;
  }

  threadContext(threadId) {
    let state, history;
    try {
      state = new DatabaseSync(join(this.codexHome, 'state_5.sqlite'), { readOnly: true });
      const metadata = state.prepare('SELECT cwd,cli_version,history_mode FROM threads WHERE id=?').get(threadId);
      if (!metadata || !/^0\.153\./.test(metadata.cli_version) || metadata.history_mode !== 'paginated' || !metadata.cwd) return null;
      history = new DatabaseSync(join(this.codexHome, 'thread_history_1.sqlite'), { readOnly: true });
      const turn = history.prepare('SELECT status FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1').get(threadId);
      return { cwd: metadata.cwd, active: turn?.status === 'inProgress' };
    } catch { return null; }
    finally { history?.close(); state?.close(); }
  }

  async stop() {
    for (const watcher of this.watchers.values()) watcher.stop();
    this.watchers.clear();
    await this.appIpc?.stop();
    await super.stop();
  }

  watch(threadId) {
    const id = requiredText(threadId, 'threadId');
    if (!this.started) throw new Error('CodexBridge not started');
    if (!this.codexHome) throw new Error('codexHome required for history observer');
    if (this.watchers.has(id)) return this.watchers.get(id).unsubscribe;
    const state = new DatabaseSync(join(this.codexHome, 'state_5.sqlite'), { readOnly: true });
    const history = new DatabaseSync(join(this.codexHome, 'thread_history_1.sqlite'), { readOnly: true });
    try {
      const metadata = state.prepare('SELECT cli_version, history_mode FROM threads WHERE id = ?').get(id);
      if (!metadata) throw new Error(`Codex thread not found: ${id}`);
      if (!/^0\.153\./.test(metadata.cli_version) || metadata.history_mode !== 'paginated') {
        throw new Error(`Unsupported Codex history schema: ${metadata.cli_version}/${metadata.history_mode}`);
      }
      for (const [table, required] of Object.entries(REQUIRED_HISTORY_COLUMNS)) {
        const columns = new Set(history.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
        if (required.some(column => !columns.has(column))) throw new Error(`Unsupported Codex history table: ${table}`);
      }
      const cursorKey = `codex-observer:${id}`;
      let savedCursor = this.getCursor?.(cursorKey);
      if (typeof savedCursor === 'string') {
        try { savedCursor = JSON.parse(savedCursor); } catch { throw new Error('Invalid Codex observer cursor'); }
      }
      const resuming = savedCursor && typeof savedCursor === 'object';
      const initialTurns = resuming ? [] : history.prepare('SELECT turn_id, rollout_ordinal, status FROM thread_turns WHERE thread_id = ?').all(id);
      const savedActive = Array.isArray(savedCursor?.activeTurns) ? savedCursor.activeTurns : [];
      const turns = new Map(resuming
        ? savedActive.filter(row => typeof row?.turnId === 'string').map(row => [row.turnId, row.status || 'inProgress'])
        : initialTurns.map(row => [row.turn_id, row.status]));
      const activeTurns = new Set(resuming
        ? savedActive.filter(row => typeof row?.turnId === 'string').map(row => row.turnId)
        : initialTurns.filter(row => row.status === 'inProgress').map(row => row.turn_id));
      let turnHighWater = resuming && Number.isInteger(savedCursor.turnHighWater)
        ? savedCursor.turnHighWater
        : initialTurns.reduce((max, row) => Math.max(max, row.rollout_ordinal), -1);
      const initialItems = resuming ? [] : history.prepare(`SELECT item_id, turn_id, updated_at_ordinal FROM thread_items
        WHERE thread_id = ? AND item_type IN ('agentMessage', 'reasoning', 'imageGeneration')`).all(id);
      const items = new Map(initialItems.map(row => [row.item_id, row.updated_at_ordinal]));
      const itemTurns = new Map(initialItems.map(row => [row.item_id, row.turn_id]));
      let itemHighWater = resuming && Number.isInteger(savedCursor.itemHighWater)
        ? savedCursor.itemHighWater
        : initialItems.reduce((max, row) => Math.max(max, row.updated_at_ordinal), -1);
      const saveCursor = () => this.setCursor?.(cursorKey, {
        version: 1,
        turnHighWater,
        itemHighWater,
        activeTurns: [...activeTurns].map(turnId => ({ turnId, status: turns.get(turnId) || 'inProgress' })),
      });
      const emit = event => {
        this.onEvent(event);
        saveCursor();
      };
      if (!resuming) saveCursor();
      let polling = false;
      let pollCount = 0;
      let timer;
      let observerClosed = false;
      const closeObserver = () => {
        if (observerClosed) return;
        observerClosed = true;
        clearInterval(timer);
        state.close();
        history.close();
      };
      const emitObserverError = error => {
        this.onEvent({ threadId: id, turnId: '', type: 'observerError', text: error?.message || String(error) });
      };
      const poll = () => {
        if (polling) return;
        polling = true;
        try {
          if (++pollCount % 20 === 0) {
            const current = state.prepare('SELECT cli_version, history_mode FROM threads WHERE id = ?').get(id);
            if (!current || !/^0\.153\./.test(current.cli_version) || current.history_mode !== 'paginated') {
              throw new Error(`Unsupported Codex history schema: ${current?.cli_version}/${current?.history_mode}`);
            }
          }
          const active = [...activeTurns];
          const placeholders = active.map(() => '?').join(',');
          const rows = history.prepare(`SELECT turn_id, rollout_ordinal, status, error_json FROM thread_turns
            WHERE thread_id = ? AND (rollout_ordinal > ?${active.length ? ` OR turn_id IN (${placeholders})` : ''})
            ORDER BY rollout_ordinal`).all(id, turnHighWater, ...active);
          const terminal = [];
          for (const row of rows) {
            const previous = turns.get(row.turn_id);
            const isNew = previous === undefined;
            if (previous !== row.status && ['completed', 'failed', 'interrupted'].includes(row.status)) terminal.push(row);
            turns.set(row.turn_id, row.status);
            turnHighWater = Math.max(turnHighWater, row.rollout_ordinal);
            if (row.status === 'inProgress') activeTurns.add(row.turn_id);
            else if (['completed', 'failed', 'interrupted'].includes(row.status)) activeTurns.add(row.turn_id);
            else activeTurns.delete(row.turn_id);
            if (isNew) emit({ threadId: id, turnId: row.turn_id, type: 'started' });
          }
          const changed = history.prepare(`SELECT turn_id, item_id, item_type, updated_at_ordinal,
              CASE WHEN item_type = 'agentMessage' THEN json_extract(item_json, '$.text') END AS agent_text,
              CASE WHEN item_type = 'agentMessage' THEN json_extract(item_json, '$.phase') END AS agent_phase,
              CASE WHEN item_type = 'agentMessage' THEN json_extract(item_json, '$.delivery') END AS agent_delivery,
              CASE WHEN item_type = 'agentMessage' THEN json_array_length(item_json, '$.questions') > 0 END AS has_questions,
              CASE WHEN item_type = 'reasoning' THEN json_extract(item_json, '$.summary') END AS summary_json,
              CASE WHEN item_type = 'imageGeneration' THEN json_extract(item_json, '$.status') END AS image_status,
              CASE WHEN item_type = 'imageGeneration' THEN json_extract(item_json, '$.savedPath') END AS image_path
            FROM thread_items
            WHERE thread_id = ? AND item_type IN ('agentMessage', 'reasoning', 'imageGeneration') AND updated_at_ordinal > ?
            ORDER BY updated_at_ordinal`).all(id, itemHighWater);
          for (const row of changed) {
            itemHighWater = Math.max(itemHighWater, row.updated_at_ordinal);
            if (items.get(row.item_id) === row.updated_at_ordinal) continue;
            items.set(row.item_id, row.updated_at_ordinal);
            itemTurns.set(row.item_id, row.turn_id);
            if (row.item_type === 'imageGeneration') {
              if (row.image_status === 'completed' && typeof row.image_path === 'string' && row.image_path) {
                emit({ threadId: id, turnId: row.turn_id, type: 'image', itemId: row.item_id, path: row.image_path });
              }
              continue;
            }
            const visible = visibleItem(row);
            const text = visible?.text;
            const phase = visible?.phase;
            if (!text) continue;
            emit({ threadId: id, turnId: row.turn_id, type: 'text', itemId: row.item_id, phase, text });
          }
          for (const row of terminal) {
            activeTurns.delete(row.turn_id);
            if (row.status === 'completed') emit({ threadId: id, turnId: row.turn_id, type: 'completed' });
            else {
              let text;
              try { text = JSON.parse(row.error_json)?.message; } catch {}
              emit({ threadId: id, turnId: row.turn_id, type: 'failed', ...(text ? { text } : {}) });
            }
            for (const [itemId, itemTurnId] of itemTurns) {
              if (itemTurnId === row.turn_id) { itemTurns.delete(itemId); items.delete(itemId); }
            }
          }
        } catch (error) {
          if (error?.code !== 'SQLITE_BUSY') {
            closeObserver();
            this.watchers.delete(id);
            emitObserverError(error);
          }
        } finally { polling = false; }
      };
      timer = setInterval(poll, this.pollMs);
      timer.unref?.();
      const watcher = {
        stop: closeObserver,
      };
      watcher.unsubscribe = () => {
        if (this.watchers.get(id) !== watcher) return;
        this.watchers.delete(id);
        watcher.stop();
      };
      this.watchers.set(id, watcher);
      return watcher.unsubscribe;
    } catch (error) {
      state.close();
      history.close();
      throw error;
    }
  }
}
