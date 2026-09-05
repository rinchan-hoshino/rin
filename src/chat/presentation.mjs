/**
 * Presentation functions extracted from Rin release f370ddf80f51.
 * Source: src/core/chat/rich-text.ts, platform/common.ts, delivery-policy.ts
 * at f370ddf80f515642513dec650bd0a0cc577d1ffe (GNU GPL v3).
 * Extracted from deployed JS and cross-checked against the original TypeScript.
 * Native Codex Markdown replaces the old rich-node input boundary. These pure
 * functions intentionally retain legacy formatting; there is no runtime import
 * from the old installation. See docs/legacy-render-audit.md for provenance.
 */
const safeString = (value) => value == null ? "" : String(value);
export const EDITABLE_INTERMEDIATE_PREFIX = "...";
export const EDITABLE_MESSAGE_SECTION_SEPARATOR = "────────";
export const DEFAULT_WORKING_TEXT = "Working...";

export function stripHtmlFormatting(text) {
    return safeString(text)
        .replace(/<\s*br\s*\/?\s*>/gi, "\n")
        .replace(/<\s*\/\s*(p|div|li|blockquote|h[1-6])\s*>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'");
}
export function stripMarkdownFormatting(text) {
    let next = safeString(text);
    next = next.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, "$1");
    next = next.replace(/`([^`]+)`/g, "$1");
    next = next.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, url) => {
        const label = safeString(alt).trim() || safeString(url).trim();
        return label ? `[image: ${label}]` : "[image]";
    });
    next = next.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
    next = next.replace(/^([\t ]{0,3})#{1,6}\s+/gm, "$1");
    next = next.replace(/^([\t ]{0,3})>\s?/gm, "$1> ");
    next = next.replace(/^([\t ]*)[-*+]\s+/gm, "$1- ");
    next = next.replace(/^([\t ]*)(\d+)[.)]\s+/gm, "$1$2. ");
    next = next.replace(/\*\*([^*\n]+)\*\*/g, "$1");
    next = next.replace(/(?<!\w)__([^_\n]+)__(?!\w)/g, "$1");
    next = next.replace(/\*([^*\n]+)\*/g, "$1");
    next = next.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "$1");
    next = next.replace(/~~(.*?)~~/g, "$1");
    return normalizeRenderedText(next);
}
export function normalizeRenderedText(text) {
    const normalized = safeString(text)
        .replace(/\r\n?/g, "\n")
        .replace(/[\t ]+\n/g, "\n");
    if (!normalized.trim())
        return "";
    return normalized
        .replace(/^(?:[\t ]*\n)+/, "")
        .replace(/(?:\n[\t ]*)+$/, "")
        .replace(/[\t ]+$/, "");
}

function escapeHtml(text) {
    return safeString(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
function escapeHtmlAttr(text) {
    return escapeHtml(text).replace(/'/g, "&#39;");
}

function sanitizeTelegramHtml(text) {
    let next = safeString(text);
    next = next.replace(/<(?!\/?(?:b|strong|i|em|u|s|strike|del|code|pre|a|blockquote|tg-spoiler)\b)[^>]*>/gi, "");
    next = next.replace(/<(a)\b([^>]*)>/gi, (_match, tag, attrs) => {
        const href = /href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.exec(attrs || "")?.[1] || "";
        const cleanHref = safeString(href)
            .replace(/^['"]|['"]$/g, "")
            .trim();
        return cleanHref
            ? `<${tag} href="${escapeHtmlAttr(cleanHref)}">`
            : `<${tag}>`;
    });
    return next;
}
export function markdownToTelegramHtml(text) {
    const placeholders = [];
    const keep = (html) => {
        const key = `\u0000${placeholders.length}\u0000`;
        placeholders.push(html);
        return key;
    };
    let next = safeString(text).replace(/\r\n?/g, "\n");
    next = next.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, (_m, body) => keep(`<pre>${escapeHtml(body)}</pre>`));
    next = next.replace(/`([^`]+)`/g, (_m, body) => keep(`<code>${escapeHtml(body)}</code>`));
    next = escapeHtml(next);
    next = next.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
    next = next.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    next = next.replace(/__([^_]+)__/g, "<b>$1</b>");
    next = next.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<i>$1</i>");
    next = next.replace(/(?<!_)_([^_\n]+)_(?!_)/g, "<i>$1</i>");
    next = next.replace(/~~([^~]+)~~/g, "<s>$1</s>");
    next = next.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) => {
        const label = safeString(alt).trim() || safeString(url).trim();
        return escapeHtml(`[image: ${label}]`);
    });
    next = next.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => `<a href="${escapeHtmlAttr(stripHtmlFormatting(url))}">${label}</a>`);
    next = next.replace(/^&gt;\s?(.*)$/gm, "<blockquote>$1</blockquote>");
    for (let i = 0; i < placeholders.length; i += 1) {
        next = next.replaceAll(`\u0000${i}\u0000`, placeholders[i] || "");
    }
    return normalizeRenderedText(sanitizeTelegramHtml(next));
}

export function editableIntermediateHeadText(text) {
    const value = safeString(text).trim();
    if (!value)
        return "";
    if (value.startsWith(`${EDITABLE_INTERMEDIATE_PREFIX} `)) {
        return value;
    }
    return `${EDITABLE_INTERMEDIATE_PREFIX} ${value}`;
}

function normalizeTextChunks(value) {
    return (Array.isArray(value) ? value : value ? [value] : [])
        .map((item) => safeString(item))
        .filter(Boolean);
}
export function emptyEditableMessageSections() {
    return {
        workingTextChunks: [],
        contentTextChunks: [],
        todoTextChunks: [],
    };
}

export function composeEditableMessageText(sections) {
    return [
        sections.workingTextChunks.map((item) => safeString(item)).join(""),
        sections.contentTextChunks.map((item) => safeString(item)).join(""),
        sections.todoTextChunks.map((item) => safeString(item)).join(""),
    ]
        .filter(Boolean)
        .join(`\n\n${EDITABLE_MESSAGE_SECTION_SEPARATOR}\n\n`);
}
export function updateEditableMessageSections(input) {
    const kind = safeString(input.kind).trim() || "working";
    const nextTextChunks = normalizeTextChunks(input.textChunks);
    const persisted = input.persisted || emptyEditableMessageSections();
    const existingWorking = normalizeTextChunks(persisted.workingTextChunks);
    const existingContent = normalizeTextChunks(persisted.contentTextChunks);
    const existingTodo = normalizeTextChunks(persisted.todoTextChunks);
    const fallbackWorking = normalizeTextChunks(input.fallbackWorkingTextChunks);
    const fallbackTodo = normalizeTextChunks(input.fallbackTodoTextChunks);
    if (input.exclusive) {
        return {
            workingTextChunks: [],
            contentTextChunks: nextTextChunks,
            todoTextChunks: [],
        };
    }
    const section = kind === "todo"
        ? "todo"
        : kind === "working" && !input.finalize
            ? "working"
            : "content";
    return {
        workingTextChunks: section === "working"
            ? nextTextChunks
            : input.finalize
                ? []
                : existingWorking.length
                    ? existingWorking
                    : fallbackWorking,
        contentTextChunks: section === "content" ? nextTextChunks : existingContent,
        todoTextChunks: input.finalize
            ? []
            : section === "todo"
                ? nextTextChunks
                : existingTodo.length
                    ? existingTodo
                    : fallbackTodo,
    };
}
export function splitPlainText(text, maxLength) {
    const normalized = normalizeRenderedText(text);
    const trimChunk = (chunk) => normalizeRenderedText(chunk);
    if (!normalized)
        return [];
    const chars = Array.from(normalized);
    const limit = Math.max(1, Math.floor(maxLength) || 1);
    const chunks = [];
    let cursor = 0;
    while (cursor < chars.length) {
        const remaining = chars.length - cursor;
        if (remaining <= limit) {
            const chunk = trimChunk(chars.slice(cursor).join(""));
            if (chunk)
                chunks.push(chunk);
            break;
        }
        const windowText = chars.slice(cursor, cursor + limit).join("");
        let splitOffset = -1;
        for (const marker of ["\n\n", "\n", " "]) {
            const markerOffset = windowText.lastIndexOf(marker);
            if (markerOffset >= 0) {
                splitOffset = markerOffset + marker.length;
                break;
            }
        }
        if (splitOffset <= 0)
            splitOffset = limit;
        const nextCursor = cursor + splitOffset;
        const chunk = trimChunk(chars.slice(cursor, nextCursor).join(""));
        if (chunk) {
            chunks.push(chunk);
            cursor = nextCursor;
            continue;
        }
        chunks.push(chars.slice(cursor, cursor + limit).join(""));
        cursor += limit;
    }
    return chunks;
}

// The legacy HTML fallback strips tags, then applies its Markdown plain renderer.
export function telegramHtmlToPlainText(text) {
    return stripMarkdownFormatting(normalizeRenderedText(stripHtmlFormatting(text)));
}

export function prepareText(platform, text, maxLength) {
    const telegram = platform === "telegram";
    const rendered = telegram ? markdownToTelegramHtml(text) : normalizeRenderedText(text);
    const limit = maxLength ?? (telegram ? 4096 : platform === "discord" ? 2000 : 4096);
    return splitPlainText(rendered, limit).map((chunk) => telegram
        ? { text: chunk, parseMode: "HTML" }
        : { text: chunk });
}

export function normalizeAssistantSummaryText(value) {
    const latestSummary = safeString(value)
        .replace(/\r\n?/g, "\n")
        .trim()
        .split(/\n\s*\n/)
        .map((item) => item.trim())
        .filter(Boolean)
        .at(-1);
    return stripMarkdownFormatting(latestSummary).replace(/\s+/g, " ").trim();
}
