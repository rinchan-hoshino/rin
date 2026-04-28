import {
  applyRegexReplacements,
  type RegexReplacement,
} from "./regex-utils.js";
import { decodeHtmlEntities, normalizePlainText } from "./text-utils.js";

const HTML_PRE_HIDDEN_REPLACEMENTS: RegexReplacement[] = [
  [/<!--[\s\S]*?-->/g, " "],
  [/<head\b[^>]*>[\s\S]*?<\/head>/gi, " "],
];
const HTML_POST_HIDDEN_REPLACEMENTS: RegexReplacement[] = [
  [/<script\b[^>]*>[\s\S]*?<\/script>/gi, " "],
  [/<style\b[^>]*>[\s\S]*?<\/style>/gi, " "],
  [/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " "],
  [/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " "],
  [/<canvas\b[^>]*>[\s\S]*?<\/canvas>/gi, " "],
  [/<template\b[^>]*>[\s\S]*?<\/template>/gi, " "],
];
const HTML_TEXT_REPLACEMENTS: RegexReplacement[] = [
  [/<(br|hr)\b[^>]*\/?\s*>/gi, "\n"],
  [
    /<\/(p|div|section|article|main|aside|header|footer|nav|li|ul|ol|h[1-6]|tr|table|blockquote)>/gi,
    "\n",
  ],
  [/<li\b[^>]*>/gi, "\n- "],
  [/<[^>]+>/g, " "],
];

function parseHtmlTagAttributes(tag: string) {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(
    /\b([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
  )) {
    const name = String(match[1] || "")
      .trim()
      .toLowerCase();
    if (!name || name === "meta") continue;
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (!attributes.has(name)) attributes.set(name, value);
  }
  return attributes;
}

function findHtmlMetaTagContent(
  html: string,
  predicate: (attributes: Map<string, string>) => boolean,
) {
  for (const match of String(html || "").matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    if (!tag) continue;
    const attributes = parseHtmlTagAttributes(tag);
    if (predicate(attributes)) {
      return attributes.get("content") || "";
    }
  }
  return "";
}

function extractCharsetFromMetaTag(attributes: Map<string, string>) {
  const declaredCharset = String(attributes.get("charset") || "").trim();
  if (declaredCharset) return declaredCharset;
  const httpEquiv = String(attributes.get("http-equiv") || "")
    .trim()
    .toLowerCase();
  if (httpEquiv !== "content-type") return "";
  const content = String(attributes.get("content") || "");
  const match = /charset\s*=\s*([^;]+)/i.exec(content);
  return match?.[1]?.trim().replace(/^"|"$/g, "") || "";
}

function extractHtmlDeclaredCharset(html: string) {
  return findHtmlMetaTagContent(html, (attributes) => {
    const charset = extractCharsetFromMetaTag(attributes);
    if (!charset) return false;
    attributes.set("content", charset);
    return true;
  });
}

export function isProbablyHtml(mimeType: string, text: string) {
  return mimeType.includes("html") || /<html\b|<body\b|<head\b/i.test(text);
}

export function sniffHtmlCharset(
  buffer: Buffer,
  mimeType: string,
  headerCharset?: string,
) {
  if (headerCharset) return headerCharset;
  const probe = buffer
    .subarray(0, Math.min(buffer.byteLength, 8192))
    .toString("latin1");
  if (!isProbablyHtml(mimeType, probe)) return undefined;
  const declaredCharset = extractHtmlDeclaredCharset(probe);
  return declaredCharset || undefined;
}

export function extractHtmlTitle(html: string) {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (titleMatch?.[1]) {
    return normalizePlainText(decodeHtmlEntities(titleMatch[1]));
  }
  const ogTitle = findHtmlMetaTagContent(html, (attributes) => {
    return (
      String(attributes.get("property") || "")
        .trim()
        .toLowerCase() === "og:title"
    );
  });
  return ogTitle ? normalizePlainText(decodeHtmlEntities(ogTitle)) : "";
}

const HIDDEN_HTML_ELEMENT_PATTERNS = [
  /<[^>]+\shidden(?=\s|=|\/?>)[^>]*>[\s\S]*?<\/[^>]+>/gi,
  /<[^>]+\saria-hidden\s*=\s*["']?true["']?[^>]*>[\s\S]*?<\/[^>]+>/gi,
  /<[^>]+\sstyle\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi,
];

function stripHiddenHtmlElements(html: string) {
  let text = String(html || "");
  for (let pass = 0; pass < 3; pass += 1) {
    const next = HIDDEN_HTML_ELEMENT_PATTERNS.reduce(
      (value, pattern) => value.replace(pattern, " "),
      text,
    );
    if (next === text) break;
    text = next;
  }
  return text;
}

export function htmlToText(html: string) {
  const stripped = applyRegexReplacements(
    stripHiddenHtmlElements(
      applyRegexReplacements(html, HTML_PRE_HIDDEN_REPLACEMENTS),
    ),
    HTML_POST_HIDDEN_REPLACEMENTS,
  );
  const text = applyRegexReplacements(stripped, HTML_TEXT_REPLACEMENTS);
  return normalizePlainText(decodeHtmlEntities(text));
}
