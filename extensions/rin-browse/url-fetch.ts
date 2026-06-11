import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

const FETCH_TIMEOUT_MS = 20_000;
const CHROME_LIKE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export type WebFetchFormat = "markdown" | "text";

export type WebFetchResult = {
  ok: boolean;
  mode: "fetch";
  url: string;
  finalUrl: string;
  status: number;
  statusText: string;
  mimeType: string;
  bytes: number;
  title?: string;
  format: WebFetchFormat;
  text?: string;
  error?: string;
};

type ReadableHtml = {
  title?: string;
  markdown: string;
  text: string;
};

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

function normalizeWhitespace(value: string) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeText(value: string) {
  return normalizeWhitespace(value.replace(/[\t ]+/g, " "));
}

function normalizeMimeType(value: string | null | undefined) {
  const [raw] = String(value || "").split(";");
  return raw.trim().toLowerCase() || "application/octet-stream";
}

function readCharset(value: string | null | undefined) {
  const match = String(value || "").match(/charset\s*=\s*([^;]+)/i);
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, "") || "utf-8";
}

function decodeBuffer(buffer: Buffer, contentType: string | null | undefined) {
  const charset = readCharset(contentType);
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

function isHtmlResponse(mimeType: string, text: string) {
  return mimeType.includes("html") || /<!doctype\s+html|<html[\s>]/i.test(text);
}

function isJsonResponse(mimeType: string) {
  return mimeType.includes("json");
}

function isTextResponse(mimeType: string) {
  return (
    mimeType.startsWith("text/") ||
    mimeType.includes("xml") ||
    mimeType.includes("javascript") ||
    mimeType.includes("typescript") ||
    mimeType === "application/octet-stream"
  );
}

function extractHtml(buffer: Buffer, finalUrl: string, contentType: string) {
  const dom = new JSDOM(buffer, {
    url: finalUrl,
    contentType: contentType || "text/html",
  });
  try {
    const reader = new Readability(dom.window.document.cloneNode(true) as any);
    const article = reader.parse();
    const title = normalizeText(
      article?.title || dom.window.document.title || "",
    );
    const contentHtml =
      article?.content || dom.window.document.body?.innerHTML || "";
    const markdown = normalizeWhitespace(turndown.turndown(contentHtml));
    const text = normalizeText(
      article?.textContent || dom.window.document.body?.textContent || "",
    );
    return { title: title || undefined, markdown, text } satisfies ReadableHtml;
  } finally {
    dom.window.close();
  }
}

function formatNonHtmlBody(text: string, mimeType: string) {
  if (isJsonResponse(mimeType)) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return normalizeText(text);
    }
  }
  return normalizeText(text);
}

export function parseFetchUrl(value: unknown): string | undefined {
  const text = String(value || "").trim();
  if (!text || /\s/.test(text)) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  return url.toString();
}

export async function fetchReadableUrl(input: {
  url: string;
  format?: WebFetchFormat;
  signal?: AbortSignal;
}): Promise<WebFetchResult> {
  const url = parseFetchUrl(input.url);
  if (!url) throw new Error("web_fetch_invalid_url");
  const format: WebFetchFormat = input.format === "text" ? "text" : "markdown";
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`fetch_timeout:${FETCH_TIMEOUT_MS}`));
  }, FETCH_TIMEOUT_MS);
  const abortFromParent = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", abortFromParent, { once: true });

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "user-agent": CHROME_LIKE_USER_AGENT,
        accept:
          "text/markdown,text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.2",
        "accept-language": "en-US,en;q=0.9",
      },
      signal: controller.signal,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type");
    const mimeType = normalizeMimeType(contentType);
    const finalUrl = response.url || url;
    const decoded = decodeBuffer(buffer, contentType);
    const base = {
      mode: "fetch" as const,
      url,
      finalUrl,
      status: response.status,
      statusText: response.statusText,
      mimeType,
      bytes: buffer.byteLength,
      format,
    };

    if (!response.ok) {
      return {
        ...base,
        ok: false,
        error: normalizeText(decoded).slice(0, 600) || response.statusText,
      };
    }

    if (isHtmlResponse(mimeType, decoded)) {
      const html = extractHtml(buffer, finalUrl, contentType || "text/html");
      return {
        ...base,
        ok: true,
        title: html.title,
        text: format === "text" ? html.text : html.markdown,
      };
    }

    if (isJsonResponse(mimeType) || isTextResponse(mimeType)) {
      return {
        ...base,
        ok: true,
        text: formatNonHtmlBody(decoded, mimeType),
      };
    }

    return {
      ...base,
      ok: false,
      error: `Unsupported content type: ${mimeType}`,
    };
  } catch (error: any) {
    return {
      ok: false,
      mode: "fetch",
      url,
      finalUrl: url,
      status: 0,
      statusText: "",
      mimeType: "",
      bytes: 0,
      format,
      error: String(error?.message || error || "fetch_failed"),
    };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abortFromParent);
  }
}
