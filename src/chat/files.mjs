import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, basename, extname, resolve } from 'node:path';
import { Lexer } from 'marked';

const safeString = value => value == null ? '' : String(value);
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MIME_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.flac': 'audio/flac', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.txt': 'text/plain', '.md': 'text/markdown',
};

// Protected source ranges are extracted unchanged from Rin f370ddf80f51,
// src/core/chat/rich-text.ts. Keep code examples as text, never attachments.
function appendMarkdownRange(ranges, start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
        return;
    ranges.push({ start, end });
}
function markdownRangeOverlaps(ranges, start, end) {
    return ranges.some((range) => start < range.end && end > range.start);
}
function locateTokenRaw(source, raw, cursor) {
    if (!raw)
        return -1;
    const afterCursor = source.indexOf(raw, Math.max(0, cursor));
    return afterCursor >= 0 ? afterCursor : source.indexOf(raw);
}
function childMarkdownTokens(token) {
    const children = [];
    if (Array.isArray(token?.tokens))
        children.push(...token.tokens);
    if (Array.isArray(token?.items))
        children.push(...token.items);
    return children;
}
function collectNestedMarkdownProtectedRanges(ranges, blockStart, blockRaw, tokens) {
    let cursor = 0;
    for (const token of Array.isArray(tokens) ? tokens : []) {
        const raw = safeString(token?.raw);
        const children = childMarkdownTokens(token);
        if (!raw) {
            if (children.length) {
                collectNestedMarkdownProtectedRanges(ranges, blockStart, blockRaw, children);
            }
            continue;
        }
        let localStart = blockRaw.indexOf(raw, cursor);
        if (localStart < 0)
            localStart = blockRaw.indexOf(raw);
        if (localStart < 0) {
            if (children.length) {
                collectNestedMarkdownProtectedRanges(ranges, blockStart, blockRaw, children);
            }
            continue;
        }
        const start = blockStart + localStart;
        const end = start + raw.length;
        const type = safeString(token?.type).trim().toLowerCase();
        if (type === "code" || type === "codespan") {
            appendMarkdownRange(ranges, start, end);
        }
        if (children.length) {
            collectNestedMarkdownProtectedRanges(ranges, start, raw, children);
        }
        cursor = localStart + raw.length;
    }
}
function collectMarkdownProtectedRanges(source) {
    const ranges = [];
    let cursor = 0;
    let tokens = [];
    try {
        tokens = Lexer.lex(source);
    }
    catch {
        return ranges;
    }
    for (const token of tokens) {
        const raw = safeString(token?.raw);
        if (!raw)
            continue;
        const start = locateTokenRaw(source, raw, cursor);
        if (start < 0)
            continue;
        const end = start + raw.length;
        const type = safeString(token?.type).trim().toLowerCase();
        if (type === "code") {
            appendMarkdownRange(ranges, start, end);
        }
        const children = childMarkdownTokens(token);
        if (children.length) {
            collectNestedMarkdownProtectedRanges(ranges, start, raw, children);
        }
        cursor = end;
    }
    return ranges.sort((a, b) => a.start - b.start || a.end - b.end);
}

function markdownLinks(source) {
  const protectedRanges = collectMarkdownProtectedRanges(source);
  const links = [];
  const visit = (tokens, parentSource, base) => {
    let cursor = 0;
    for (const token of tokens || []) {
      const raw = safeString(token.raw);
      if (!raw) continue;
      const local = locateTokenRaw(parentSource, raw, cursor);
      if (local < 0) continue;
      cursor = local + raw.length;
      const start = base + local;
      const end = start + raw.length;
      if (token.type === 'code' || token.type === 'codespan' || markdownRangeOverlaps(protectedRanges, start, end)) continue;
      if (token.type === 'image' || token.type === 'link') {
        links.push({ start, end, href: token.href });
        continue;
      }
      visit(childMarkdownTokens(token), raw, start);
      // Tables store inline tokens in cells rather than token.tokens.
      if (token.type === 'table') {
        const cells = [...(token.header || []), ...(token.rows || []).flat()];
        let cellCursor = 0;
        for (const cell of cells) {
          const cellText = safeString(cell.text);
          const at = raw.indexOf(cellText, cellCursor);
          if (at < 0 || !cellText) continue;
          cellCursor = at + cellText.length;
          visit(cell.tokens, cellText, start + at);
        }
      }
    }
  };
  try { visit(Lexer.lex(source), source, 0); } catch { return []; }
  return links.sort((a, b) => a.start - b.start);
}

function attachment(href, safeRoots) {
  let filePath;
  try { filePath = decodeURIComponent(safeString(href)); } catch { return null; }
  if (!isAbsolute(filePath)) return null;
  try {
    filePath = realpathSync(filePath);
    if (!safeRoots.some(root => {
      const rel = relative(root, filePath);
      return rel === '' || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel));
    })) return null;
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) return null;
    return { path: filePath, name: basename(filePath), mimeType: MIME_TYPES[extname(filePath).toLowerCase()] };
  } catch { return null; }
}

/** Native Markdown text/media parts in original order; no remote downloads. */
export function outputParts(text, roots = []) {
  const source = safeString(text).replace(/\r\n?/g, '\n');
  const safeRoots = roots.flatMap(root => {
    try { return [realpathSync(resolve(root))]; } catch { return []; }
  });
  const parts = [];
  let cursor = 0;
  for (const link of markdownLinks(source)) {
    if (link.start < cursor) continue;
    const file = attachment(link.href, safeRoots);
    if (!file) continue;
    const before = source.slice(cursor, link.start);
    if (before) parts.push({ text: before });
    parts.push({ files: [file] });
    cursor = link.end;
  }
  if (cursor < source.length) parts.push({ text: source.slice(cursor) });
  return parts;
}

/** Backward-compatible unique file list. */
export function outputFiles(text, roots = []) {
  const seen = new Set();
  return outputParts(text, roots).flatMap(part => part.files || []).filter(file => {
    if (seen.has(file.path)) return false;
    seen.add(file.path);
    return true;
  });
}
