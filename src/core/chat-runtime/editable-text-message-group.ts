import fs from "node:fs";
import path from "node:path";

import {
  composeEditableMessageText,
  editableIntermediateHeadText,
  editableMessageSectionsFromRecord,
  editableWorkingText,
  ensureDir,
  ensureFileName,
  isEditableWorkingText,
  resolveChatRuntimeWorkingCopy,
  safeString,
  splitPlainText,
  updateEditableMessageSections,
} from "./common.js";

export type EditableTextMessageIndicatorTickInput = {
  chatId: string;
  text: string;
  replyToMessageId?: string;
  key?: string;
  todoText?: string;
  todoTextChunks?: string[];
};

export type EditableTextMessageIndicatorOptions = {
  prepareTick?: (
    context: any,
    input: EditableTextMessageIndicatorTickInput,
  ) => EditableTextMessageIndicatorTickInput | null;
};

export type EditableTextMessageGroupOptions = {
  cacheDir: string;
  cacheScope: string;
  maxTextLength: number;
  workingText?: string;
  agentDir?: string;
  workingFrames?: string[];
  progressTexts?: string[];
  chunkText?: (text: string) => string[];
  sendText: (input: {
    chatId: string;
    text: string;
    replyToMessageId?: string;
  }) => Promise<string | string[]>;
  editText: (input: {
    chatId: string;
    messageId: string;
    text: string;
  }) => Promise<string | string[]>;
  deleteMessage: (input: {
    chatId: string;
    messageId: string;
  }) => Promise<unknown>;
  isRecoverableEditError?: (error: unknown) => boolean;
  repeatReplyToMessageId?: boolean;
};

function sanitizeCacheScope(value: unknown, fallback: string) {
  return (
    safeString(value)
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "_") || fallback
  );
}

function normalizeDeliveredIds(value: unknown) {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => safeString(item).trim()).filter(Boolean);
}

export class EditableTextMessageGroup {
  private readonly messages = new Map<string, string>();
  private readonly texts = new Map<string, string>();
  private readonly kinds = new Map<string, string>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly finalizing = new Set<string>();
  private workingText: string;
  private workingFrames: string[];
  private progressTexts: string[];

  constructor(private readonly options: EditableTextMessageGroupOptions) {
    const copy = resolveChatRuntimeWorkingCopy(options.agentDir);
    this.workingFrames = normalizeDeliveredIds(
      options.workingFrames?.length ? options.workingFrames : copy.frames,
    );
    this.workingText = editableIntermediateHeadText(
      safeString(options.workingText).trim() ||
        this.workingFrames[0] ||
        "Working...",
    );
    this.progressTexts = normalizeDeliveredIds([
      this.workingText,
      ...this.workingFrames.map(editableIntermediateHeadText),
      ...(options.progressTexts?.length
        ? options.progressTexts
        : copy.progressTexts
      ).map(editableIntermediateHeadText),
    ]);
    ensureDir(this.options.cacheDir);
  }

  setWorkingFrames(frames: string[]) {
    const configured = normalizeDeliveredIds(frames);
    const normalized = configured.length
      ? configured
      : resolveChatRuntimeWorkingCopy().frames;
    this.workingFrames = normalized;
    this.workingText = editableIntermediateHeadText(normalized[0]);
    this.progressTexts = normalizeDeliveredIds([
      this.workingText,
      ...normalized.map(editableIntermediateHeadText),
    ]);
  }

  indicator(options: EditableTextMessageIndicatorOptions = {}) {
    return {
      type: "polling",
      presentation: "editable-message",
      tick: async (context: any) => {
        const statusText = safeString(context?.workingStatusText).trim();
        const summaryText = safeString(context?.assistantSummaryText).trim();
        const defaultInput: EditableTextMessageIndicatorTickInput = {
          chatId: safeString(context?.chatId).trim(),
          text: editableIntermediateHeadText(
            statusText ||
              summaryText ||
              editableWorkingText(context?.tick, this.workingFrames),
          ),
          replyToMessageId:
            safeString(context?.replyToMessageId).trim() || undefined,
          todoText: context?.todoNoticeText,
        };
        const input = options.prepareTick
          ? options.prepareTick(context, defaultInput)
          : defaultInput;
        if (!input || !safeString(input.chatId).trim()) return false;
        const ids = await this.updateText({
          ...input,
          kind: "working",
        });
        return ids.length > 0;
      },
      end: async (context: any) => {
        // Normal lifecycle completion is finalized by the fresh delivery path.
        // A presentation transfer changes the quote key, so that path can no
        // longer retire the previous owner's progress message.
        if (context?.endReason !== "presentation_transferred") return false;
        const chatId = safeString(context?.chatId).trim();
        if (!chatId) return false;
        return await this.deleteProgress(
          chatId,
          safeString(context?.replyToMessageId).trim() || undefined,
        );
      },
    };
  }

  private key(chatId: string, replyToMessageId?: string, keyOverride = "") {
    const override = safeString(keyOverride).trim();
    if (override) return override;
    const replyKey = safeString(replyToMessageId).trim();
    return replyKey ? `${chatId}:quote:${replyKey}` : `${chatId}:chat`;
  }

  private statePath(key: string) {
    const fileName = ensureFileName(
      `${safeString(key).trim()}.json`,
      "working-message.json",
    );
    return path.join(
      this.options.cacheDir,
      "working-messages",
      sanitizeCacheScope(this.options.cacheScope, "default"),
      fileName,
    );
  }

  private read(key: string) {
    try {
      const record = JSON.parse(fs.readFileSync(this.statePath(key), "utf8"));
      const messageIds = (
        Array.isArray(record?.messageIds)
          ? record.messageIds
          : [record?.messageId]
      )
        .map((item: unknown) => safeString(item).trim())
        .filter(Boolean);
      if (!messageIds.length) return null;
      const textChunks = (
        Array.isArray(record?.textChunks) ? record.textChunks : [record?.text]
      ).map((item: unknown) => safeString(item));
      const text = textChunks.length
        ? textChunks.join("")
        : safeString(record?.text);
      const kind = safeString(record?.kind).trim();
      const sections = editableMessageSectionsFromRecord({
        ...record,
        kind,
        text,
        textChunks,
      });
      return {
        messageIds,
        text,
        textChunks: textChunks.length ? textChunks : [text],
        kind,
        workingText: sections.workingTextChunks.join(""),
        workingTextChunks: sections.workingTextChunks,
        contentText: sections.contentTextChunks.join(""),
        contentTextChunks: sections.contentTextChunks,
        todoText: sections.todoTextChunks.join(""),
        todoTextChunks: sections.todoTextChunks,
      };
    } catch {
      return null;
    }
  }

  private write(
    key: string,
    messageIds: string[],
    textChunks: string[],
    kind: string,
    sections: {
      workingTextChunks?: string[];
      contentTextChunks?: string[];
      todoTextChunks?: string[];
    } = {},
  ) {
    const nextMessageIds = normalizeDeliveredIds(messageIds);
    if (!nextMessageIds.length) return;
    const statePath = this.statePath(key);
    ensureDir(path.dirname(statePath));
    const nextTextChunks = textChunks.map((item) => safeString(item));
    const workingTextChunks = (sections.workingTextChunks || []).map((item) =>
      safeString(item),
    );
    const contentTextChunks = (sections.contentTextChunks || []).map((item) =>
      safeString(item),
    );
    const todoTextChunks = (sections.todoTextChunks || []).map((item) =>
      safeString(item),
    );
    fs.writeFileSync(
      statePath,
      `${JSON.stringify(
        {
          key,
          messageId: nextMessageIds[0],
          messageIds: nextMessageIds,
          text: nextTextChunks.join(""),
          textChunks: nextTextChunks,
          kind: safeString(kind).trim(),
          workingText: workingTextChunks.join(""),
          workingTextChunks,
          contentText: contentTextChunks.join(""),
          contentTextChunks,
          todoText: todoTextChunks.join(""),
          todoTextChunks,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  private clear(key: string) {
    this.messages.delete(key);
    this.texts.delete(key);
    this.kinds.delete(key);
    try {
      fs.rmSync(this.statePath(key), { force: true });
    } catch {}
  }

  private remember(
    key: string,
    messageIds: string[],
    textChunks: string[],
    kind: string,
    sections: {
      workingTextChunks?: string[];
      contentTextChunks?: string[];
      todoTextChunks?: string[];
    } = {},
  ) {
    const nextMessageIds = normalizeDeliveredIds(messageIds);
    if (!nextMessageIds.length) {
      this.clear(key);
      return;
    }
    const text = textChunks.map((item) => safeString(item)).join("");
    const nextKind = safeString(kind).trim();
    this.messages.set(key, nextMessageIds[0] || "");
    this.texts.set(key, text);
    this.kinds.set(key, nextKind);
    this.write(key, nextMessageIds, textChunks, nextKind, sections);
  }

  private markFinalizing(key: string) {
    this.finalizing.add(key);
    setTimeout(() => this.finalizing.delete(key), 30_000).unref?.();
  }

  private recoverable(error: unknown) {
    if (this.options.isRecoverableEditError?.(error)) return true;
    const message = safeString((error as any)?.message || error).trim();
    return /not found|unknown message|can't be edited|cannot edit|message_not_found|invalid_ts|message_not_found/i.test(
      message,
    );
  }

  private async withOperation<T>(key: string, operation: () => Promise<T>) {
    const previous = this.operations.get(key) || Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    this.operations.set(key, run);
    try {
      return await run;
    } finally {
      if (this.operations.get(key) === run) this.operations.delete(key);
    }
  }

  private existingIds(key: string) {
    const persisted = this.read(key);
    if (persisted?.messageIds?.length) {
      this.messages.set(key, persisted.messageIds[0] || "");
      this.texts.set(key, persisted.text);
      this.kinds.set(key, persisted.kind);
      return persisted.messageIds;
    }
    return normalizeDeliveredIds(this.messages.get(key));
  }

  private textChunks(text: string) {
    const chunkText = this.options.chunkText;
    return (
      chunkText
        ? chunkText(text)
        : splitPlainText(text, this.options.maxTextLength)
    ).filter(Boolean);
  }

  async updateText(input: {
    chatId: string;
    text?: string;
    textChunks?: string[];
    replyToMessageId?: string;
    finalize?: boolean;
    kind?: string;
    todoText?: string;
    todoTextChunks?: string[];
    exclusive?: boolean;
    key?: string;
  }) {
    const chatId = safeString(input.chatId).trim();
    const inputTextChunks = (
      input.textChunks?.length ? input.textChunks : [input.text]
    )
      .map((item) => safeString(item))
      .filter(Boolean);
    if (!chatId || !inputTextChunks.length) return [] as string[];
    const key = this.key(chatId, input.replyToMessageId, input.key);
    const finalize = Boolean(input.finalize);
    const kind =
      safeString(input.kind).trim() || (finalize ? "final" : "working");
    if (!finalize && this.finalizing.has(key)) {
      return normalizeDeliveredIds(this.messages.get(key));
    }
    return await this.withOperation(key, async () => {
      if (!finalize && this.finalizing.has(key)) {
        return normalizeDeliveredIds(this.messages.get(key));
      }
      const persisted = this.read(key);
      const fallbackTodoText = safeString(input.todoText).trim();
      const sections = updateEditableMessageSections({
        kind,
        textChunks: inputTextChunks,
        persisted,
        fallbackWorkingTextChunks: [this.workingText],
        fallbackTodoTextChunks: input.todoTextChunks?.length
          ? input.todoTextChunks
          : fallbackTodoText
            ? [fallbackTodoText]
            : [],
        exclusive: input.exclusive,
        finalize,
      });
      const chunks = this.textChunks(composeEditableMessageText(sections));
      if (!chunks.length) return [] as string[];
      const existing = this.existingIds(key);
      if (
        !finalize &&
        existing.length &&
        (this.texts.get(key) || persisted?.text || "") === chunks.join("")
      ) {
        return existing;
      }
      const delivered: string[] = [];
      let firstReply = safeString(input.replyToMessageId).trim() || undefined;
      let editFailed = false;
      let editedExistingCount = 0;
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index] || "";
        const existingId = existing[index] || "";
        if (existingId && !editFailed) {
          try {
            const edited = await this.options.editText({
              chatId,
              messageId: existingId,
              text: chunk,
            });
            const editedIds = normalizeDeliveredIds(edited);
            delivered.push(...(editedIds.length ? editedIds : [existingId]));
            editedExistingCount += 1;
            firstReply = undefined;
            continue;
          } catch (error) {
            if (!this.recoverable(error)) throw error;
            editFailed = true;
          }
        }
        const sent = await this.options.sendText({
          chatId,
          text: chunk,
          replyToMessageId: firstReply,
        });
        const sentIds = normalizeDeliveredIds(sent);
        delivered.push(...sentIds);
        if (sentIds.length && !this.options.repeatReplyToMessageId) {
          firstReply = undefined;
        }
      }
      const surplusStart = editFailed ? editedExistingCount : delivered.length;
      for (const surplusId of existing.slice(surplusStart)) {
        try {
          await this.options.deleteMessage({ chatId, messageId: surplusId });
        } catch {}
      }
      if (!delivered.length) return [] as string[];
      if (finalize) {
        const hadExistingProgress = existing.length > 0;
        this.clear(key);
        if (hadExistingProgress) this.markFinalizing(key);
      } else {
        this.remember(key, delivered, chunks, kind, sections);
      }
      return delivered;
    });
  }

  async deleteProgress(
    chatId: string,
    replyToMessageId?: string,
    keyOverride = "",
    options: { markFinalizing?: boolean } = {},
  ) {
    const key = this.key(chatId, replyToMessageId, keyOverride);
    return await this.withOperation(key, async () => {
      const persisted = this.read(key);
      const messageIds = persisted?.messageIds?.length
        ? persisted.messageIds
        : normalizeDeliveredIds(this.messages.get(key));
      const kind = safeString(
        this.kinds.get(key) || persisted?.kind || "",
      ).trim();
      const text = safeString(this.texts.get(key) || persisted?.text || "");
      const isProgressArtifact =
        kind === "todo" ||
        kind === "working" ||
        kind === "interim" ||
        (!kind &&
          (text === this.workingText ||
            isEditableWorkingText(text, this.progressTexts)));
      if (!messageIds.length || !isProgressArtifact) return false;
      if (options.markFinalizing !== false) this.markFinalizing(key);
      for (const messageId of messageIds) {
        try {
          await this.options.deleteMessage({ chatId, messageId });
        } catch {}
      }
      this.clear(key);
      return true;
    });
  }
}
