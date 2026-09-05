// Extracted from Rin extensions lark-platform.ts at 3c3b14b (GPL-3.0).
// Pure Markdown-to-post rendering only; no legacy runtime dependency.
import { Lexer } from 'marked';
const safeString = value => value == null ? '' : String(value);
export function normalizeLarkMarkdownListBlocks(text        ) {
  const lines = safeString(text).replace(/\r\n?/g, "\n").split("\n");
  const out           = [];
  let inFence = false;
  let previousWasList = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const blank = !line.trim();
    const listItem = !inFence && /^\s{0,3}(?:[-*+]\s+|\d+[.)]\s+)/.test(line);
    if (!inFence && previousWasList && !blank && !listItem) {
      const last = out[out.length - 1];
      if (last !== undefined && last.trim()) out.push("");
    }
    out.push(line);
    previousWasList = !inFence && listItem;
    if (blank) previousWasList = false;
  }
  return out.join("\n");
}

function larkPostStyle(styles          ) {
  return styles.length ? { style: [...new Set(styles)] } : {};
}

function renderLarkInlineElements(
  tokens       ,
  styles           = [],
)               {
  const elements        = [];
  const inlineTokens = Array.isArray(tokens) ? tokens : [];
  for (let index = 0; index < inlineTokens.length; index += 1) {
    const token = inlineTokens[index];
    const type = safeString(token?.type).trim();
    if (type === "text" || type === "escape") {
      elements.push({
        tag: "text",
        text: safeString(token?.text),
        ...larkPostStyle(styles),
      });
      continue;
    }
    if (type === "strong" || type === "em" || type === "del") {
      const style =
        type === "strong" ? "bold" : type === "em" ? "italic" : "lineThrough";
      const nested = renderLarkInlineElements(token?.tokens, [
        ...styles,
        style,
      ]);
      if (!nested) return null;
      elements.push(...nested);
      continue;
    }
    if (type === "link") {
      const href = safeString(token?.href).trim();
      if (!href) return null;
      const nested = renderLarkInlineElements(token?.tokens, styles);
      if (!nested?.length || nested.some((element) => element.tag !== "text")) {
        return null;
      }
      elements.push(
        ...nested.map((element) => ({
          tag: "a",
          text: element.text,
          href,
          ...(element.style ? { style: element.style } : {}),
        })),
      );
      continue;
    }
    if (type === "br") {
      elements.push({ tag: "text", text: "\n", ...larkPostStyle(styles) });
      continue;
    }
    if (type === "html") {
      const match = safeString(token?.raw).match(/^<at\s+user_id="([^"]+)">$/);
      if (!match) return null;
      const nextToken = inlineTokens[index + 1];
      const followingToken = inlineTokens[index + 2];
      const closeIndex =
        safeString(nextToken?.raw) === "</at>"
          ? index + 1
          : safeString(nextToken?.type) === "text" &&
              safeString(followingToken?.raw) === "</at>"
            ? index + 2
            : -1;
      if (closeIndex < 0) return null;
      elements.push({
        tag: "at",
        user_id: match[1],
        ...larkPostStyle(styles),
      });
      index = closeIndex;
      continue;
    }
    return null;
  }
  return elements;
}

function renderLarkPostBlock(token     )        {
  const type = safeString(token?.type).trim();
  if (type === "paragraph" || type === "text") {
    const inline = renderLarkInlineElements(token?.tokens);
    if (inline?.length) return inline;
  }
  if (type === "heading") {
    const inline = renderLarkInlineElements(token?.tokens, ["bold"]);
    if (inline?.length) return inline;
  }
  if (type === "code") {
    const language = safeString(token?.lang).trim().split(/\s+/)[0];
    return [
      {
        tag: "code_block",
        ...(language ? { language } : {}),
        text: safeString(token?.text),
      },
    ];
  }
  if (type === "hr") return [{ tag: "hr" }];
  return [{ tag: "md", text: safeString(token?.raw) }];
}

export function renderLarkPostContent(text        ) {
  const source = safeString(text).replace(/\r\n?/g, "\n");
  try {
    const tokens = Lexer.lex(source, { gfm: true })         ;
    const content          = [];
    let pendingBlank = false;
    let previousRaw = "";
    for (const token of tokens) {
      if (safeString(token?.type).trim() === "space") {
        pendingBlank = true;
        continue;
      }
      if (content.length && (pendingBlank || /\n{2,}$/.test(previousRaw))) {
        content.push([{ tag: "text", text: "\n" }]);
      }
      const row = renderLarkPostBlock(token);
      if (row.length) content.push(row);
      previousRaw = safeString(token?.raw);
      pendingBlank = false;
    }
    return content.length ? content : [[{ tag: "text", text: source }]];
  } catch {
    return [[{ tag: "md", text: source }]];
  }
}


export function postData(text) { return {msg_type:'post',content:JSON.stringify({zh_cn:{content:renderLarkPostContent(normalizeLarkMarkdownListBlocks(text))}})}; }
