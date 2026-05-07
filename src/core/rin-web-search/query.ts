const SEARCH_TIMEOUT_MS = 8_000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; RinWebSearch/1.0; +https://github.com/rinchanai/rin)";
// SearXNG's Google engine intentionally uses a Google Go / mobile Chrome
// user-agent with the NSTNWV marker. In current Google HTML this avoids the
// JavaScript-only SG_REL shell returned to generic bot/desktop user-agents and
// exposes the server-rendered <a data-ved> result cards that the engine parses.
// Keep the Google request close to SearXNG's low-noise shape: localized
// supported domain + hl/lr/cr, utf8 encoding, filter=0, CONSENT cookie, Accept
// */*, and no ineffective num/gl parameters.
const GOOGLE_GSA_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 10; HUAWEI P30 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.105 Mobile Safari/537.36 NSTNWV";
const GOOGLE_SUPPORTED_DOMAINS: Record<string, string> = {
  AU: "www.google.com.au",
  CA: "www.google.ca",
  CN: "www.google.com.hk",
  DE: "www.google.de",
  ES: "www.google.es",
  FR: "www.google.fr",
  GB: "www.google.co.uk",
  HK: "www.google.com.hk",
  JP: "www.google.co.jp",
  TW: "www.google.com.tw",
  US: "www.google.com",
};
// SearXNG's DuckDuckGo engine avoids the lite GET flow and emulates the
// no-JS HTML form submission with a stable browser user-agent, Sec-Fetch
// navigation headers, form data, and matching cookies. DDG's bot blocker uses
// the user-agent/IP reputation and may evaluate these browser-navigation
// headers, so keep this request shape close to that real browser flow.
const DUCKDUCKGO_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const SUPPORTED_FRESHNESS = ["day", "week", "month", "year"] as const;
const FRESHNESS_QUERY_CODES: Record<WebSearchFreshness, string> = {
  day: "d",
  week: "w",
  month: "m",
  year: "y",
};

export const DIRECT_WEB_SEARCH_PROVIDERS = ["google", "duckduckgo"] as const;

export type WebSearchFreshness = (typeof SUPPORTED_FRESHNESS)[number];

export type WebSearchRequest = {
  q: string;
  limit?: number;
  domains?: string[];
  freshness?: WebSearchFreshness;
  language?: string;
};

export type WebSearchResult = {
  position: number;
  title: string;
  url: string;
  domain: string;
  snippet: string;
  engine: string;
  publishedDate: string;
};

export type WebSearchAttempt = {
  engine: string;
  ok: boolean;
  results?: number;
  error?: string;
};

export type WebSearchResponse = {
  ok: boolean;
  query: string;
  results: WebSearchResult[];
  engine?: string;
  attempts?: WebSearchAttempt[];
  error?: string;
};

type SearchSiteConstraint = {
  domain: string;
  pathPrefix: string;
};

type NormalizedWebSearchRequest = {
  q: string;
  limit: number;
  domains: string[];
  siteConstraints: SearchSiteConstraint[];
  freshness?: WebSearchFreshness;
  language: string;
};

type FetchTextOptions = {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit;
  timeoutMs?: number;
};

type DirectProvider = {
  name: (typeof DIRECT_WEB_SEARCH_PROVIDERS)[number];
  search: (request: NormalizedWebSearchRequest) => Promise<WebSearchResult[]>;
};

export function safeText(value: unknown): string {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function truncateText(value: unknown, max = 240): string {
  const text = safeText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function formatFetchUrl(value: string): string {
  try {
    const url = new URL(value);
    return truncateText(`${url.origin}${url.pathname}${url.search}`, 260);
  } catch {
    return truncateText(value, 260);
  }
}

function formatErrorSummary(error: unknown): string {
  if (!error) return "unknown_error";
  const name = safeText((error as { name?: unknown })?.name);
  const message = safeText(error instanceof Error ? error.message : error);
  const code = safeText((error as { code?: unknown })?.code);
  const parts = [name && name !== "Error" ? name : "", code, message]
    .filter(Boolean)
    .join(": ");
  return truncateText(parts || String(error), 220);
}

function formatFetchFailure(url: string, error: unknown): string {
  const cause = (error as { cause?: unknown })?.cause;
  const causeText = cause ? ` cause=${formatErrorSummary(cause)}` : "";
  return `fetch_failed url=${formatFetchUrl(url)} error=${formatErrorSummary(error)}${causeText}`;
}

function isSupportedFreshness(value: string): value is WebSearchFreshness {
  return (SUPPORTED_FRESHNESS as readonly string[]).includes(value);
}

function normalizeSiteConstraint(value: string): SearchSiteConstraint | null {
  const input = safeText(value)
    .replace(/^['"]+|['"),.]+$/g, "")
    .replace(/^site:/i, "")
    .replace(/^\*\./, "");
  if (!input) return null;

  try {
    const url = new URL(
      /^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`,
    );
    const domain = safeText(url.hostname).replace(/^www\./, "");
    if (!domain) return null;
    const pathPrefix = safeText(url.pathname === "/" ? "" : url.pathname);
    return { domain, pathPrefix };
  } catch {
    const [domain = "", ...pathParts] = input.split("/");
    const normalizedDomain = safeText(domain).replace(/^www\./, "");
    if (!normalizedDomain) return null;
    const pathPrefix = pathParts.length ? `/${pathParts.join("/")}` : "";
    return { domain: normalizedDomain, pathPrefix };
  }
}

function formatSiteConstraint(constraint: SearchSiteConstraint): string {
  return `${constraint.domain}${constraint.pathPrefix}`;
}

function normalizeDomainFilters(domains: unknown[]): string[] {
  return Array.from(
    new Set(
      domains
        .map((item) => normalizeSiteConstraint(safeText(item)))
        .filter((item): item is SearchSiteConstraint => Boolean(item))
        .map(formatSiteConstraint),
    ),
  ).slice(0, 8);
}

function extractSiteConstraints(
  query: string,
  domains: string[],
): SearchSiteConstraint[] {
  const constraints: SearchSiteConstraint[] = [];
  for (const domain of domains) {
    const constraint = normalizeSiteConstraint(domain);
    if (constraint) constraints.push(constraint);
  }

  const pattern = /(?:^|\s)site:([^\s)]+)/gi;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(query))) {
    const constraint = normalizeSiteConstraint(match[1] || "");
    if (constraint) constraints.push(constraint);
  }

  const seen = new Set<string>();
  return constraints.filter((constraint) => {
    const key = `${constraint.domain}\n${constraint.pathPrefix}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function normalizeSearchRequest(
  raw: WebSearchRequest | null | undefined,
): NormalizedWebSearchRequest {
  const q = safeText(raw?.q);
  const limit = Math.max(1, Math.min(8, Number(raw?.limit || 5) || 5));
  const language = safeText(raw?.language) || "all";
  const freshnessValue = safeText(raw?.freshness).toLowerCase();
  const freshness = isSupportedFreshness(freshnessValue)
    ? freshnessValue
    : undefined;
  const domainValues = Array.isArray(raw?.domains) ? raw.domains : [];
  const domains = normalizeDomainFilters(domainValues);
  const siteConstraints = extractSiteConstraints(q, domains);
  return { q, limit, language, freshness, domains, siteConstraints };
}

export function buildSearchQuery(
  request: ReturnType<typeof normalizeSearchRequest>,
  options: { includeDomains?: boolean } = {},
): string {
  const includeDomains = options.includeDomains !== false;
  const domainTerms = includeDomains
    ? request.domains.map((domain) => `site:${domain}`)
    : [];
  return [request.q, ...domainTerms].filter(Boolean).join(" ");
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function decodeHtmlEntities(text: string): string {
  return String(text || "").replace(
    /&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi,
    (_match, entity) => {
      const value = String(entity || "").toLowerCase();
      if (value === "amp") return "&";
      if (value === "lt") return "<";
      if (value === "gt") return ">";
      if (value === "quot") return '"';
      if (value === "apos") return "'";
      if (value === "nbsp") return " ";
      if (value.startsWith("#x")) {
        const code = Number.parseInt(value.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : "";
      }
      if (value.startsWith("#")) {
        const code = Number.parseInt(value.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : "";
      }
      return "";
    },
  );
}

function stripHtml(text: string): string {
  return safeText(
    decodeHtmlEntities(
      String(text || "")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    ),
  ).replace(/\s+([.,!?;:])/g, "$1");
}

function buildAcceptLanguage(language: string): string {
  const value = safeText(language);
  if (!value || value === "all") return "en-US,en;q=0.9";
  if (value.includes(",")) return value;
  return `${value},en;q=0.3`;
}

function parseLocale(
  language: string,
): { lang: string; region: string } | null {
  const value = safeText(language);
  if (!value || value === "all") return null;

  const normalized = value.replace(/_/g, "-");
  const parts = normalized.split("-").filter(Boolean);
  if (!parts.length) return null;

  const lang = parts[0]!.toLowerCase();
  let region = parts[1]?.toUpperCase() || "";

  if (!region) {
    if (lang === "zh") region = "CN";
    else if (lang === "en") region = "US";
    else if (lang === "ja") region = "JP";
    else if (lang === "fr") region = "FR";
    else if (lang === "de") region = "DE";
    else if (lang === "es") region = "ES";
  }

  return { lang, region };
}

function mapGoogleLanguage(language: string) {
  const locale = parseLocale(language);
  if (!locale) {
    return { hl: "en-US", lr: "", country: "" };
  }

  if (locale.lang === "zh") {
    if (locale.region === "TW" || locale.region === "HK") {
      return {
        hl: `zh-${locale.region}`,
        lr: "lang_zh-TW",
        country: locale.region,
      };
    }
    return { hl: "zh-CN", lr: "lang_zh-CN", country: locale.region || "CN" };
  }

  if (locale.lang === "en") {
    return {
      hl: locale.region ? `en-${locale.region}` : "en-US",
      lr: "lang_en",
      country: locale.region,
    };
  }

  return {
    hl: locale.region ? `${locale.lang}-${locale.region}` : locale.lang,
    lr: `lang_${locale.lang}`,
    country: locale.region,
  };
}

function googleSubdomain(country: string): string {
  return GOOGLE_SUPPORTED_DOMAINS[country.toUpperCase()] || "www.google.com";
}

function mapFreshness(freshness: string | undefined): string {
  const value = safeText(freshness).toLowerCase();
  return isSupportedFreshness(value) ? FRESHNESS_QUERY_CODES[value] : "";
}

function setFreshnessSearchParam(
  url: URL,
  freshness: string | undefined,
  paramName: string,
  formatValue: (code: string) => string = (code) => code,
) {
  const code = mapFreshness(freshness);
  if (code) url.searchParams.set(paramName, formatValue(code));
}

function buildGoogleUrl(request: NormalizedWebSearchRequest): string {
  const language = mapGoogleLanguage(request.language);
  const url = new URL(`https://${googleSubdomain(language.country)}/search`);
  url.searchParams.set("q", buildSearchQuery(request));
  url.searchParams.set("hl", language.hl);
  url.searchParams.set("ie", "utf8");
  url.searchParams.set("oe", "utf8");
  url.searchParams.set("filter", "0");
  if (language.lr) url.searchParams.set("lr", language.lr);
  if (language.country)
    url.searchParams.set("cr", `country${language.country}`);
  setFreshnessSearchParam(
    url,
    request.freshness,
    "tbs",
    (code) => `qdr:${code}`,
  );
  return url.toString();
}

function duckDuckGoRegion(request: NormalizedWebSearchRequest): string {
  const locale = parseLocale(request.language);
  if (!locale?.region) return "wt-wt";
  return `${locale.region.toLowerCase()}-${locale.lang}`;
}

function buildDuckDuckGoUrl(): string {
  return "https://html.duckduckgo.com/html/";
}

function buildDuckDuckGoBody(
  request: NormalizedWebSearchRequest,
): URLSearchParams {
  const body = new URLSearchParams();
  body.set("q", buildSearchQuery(request));
  body.set("b", "");
  body.set("kl", duckDuckGoRegion(request));
  const freshness = mapFreshness(request.freshness);
  if (freshness) body.set("df", freshness);
  return body;
}

function buildDuckDuckGoCookie(request: NormalizedWebSearchRequest): string {
  const values = [`kl=${duckDuckGoRegion(request)}`];
  const freshness = mapFreshness(request.freshness);
  if (freshness) values.push(`df=${freshness}`);
  return values.join("; ");
}

async function fetchText(
  url: string,
  {
    method = "GET",
    headers = {},
    body = undefined,
    timeoutMs = SEARCH_TIMEOUT_MS,
  }: FetchTextOptions = {},
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`timeout:${timeoutMs}`)),
    Math.max(1, timeoutMs),
  );
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.2",
          "User-Agent": USER_AGENT,
          ...headers,
        },
        body,
        signal: controller.signal,
      });
    } catch (error: unknown) {
      throw new Error(formatFetchFailure(url, error));
    }

    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `http_${response.status} url=${formatFetchUrl(response.url || url)} status=${truncateText(response.statusText, 80)} body=${truncateText(text || response.statusText)}`,
      );
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function buildResultRow(
  url: string,
  title: string,
  snippet: string,
  engine: string,
  position: number,
): WebSearchResult | null {
  const normalizedUrl = safeText(url);
  if (!normalizedUrl) return null;
  return {
    position,
    title: safeText(title) || "(untitled)",
    url: normalizedUrl,
    domain: hostOf(normalizedUrl),
    snippet: safeText(snippet).slice(0, 400),
    engine,
    publishedDate: "",
  };
}

function domainMatches(hostname: string, domain: string): boolean {
  const host = safeText(hostname).toLowerCase();
  const target = safeText(domain)
    .toLowerCase()
    .replace(/^www\./, "");
  if (!host || !target) return false;
  return host === target || host.endsWith(`.${target}`);
}

function pathMatches(pathname: string, pathPrefix: string): boolean {
  const path = safeText(pathname) || "/";
  const prefix = safeText(pathPrefix);
  if (!prefix) return true;
  return (
    path === prefix ||
    path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)
  );
}

function siteConstraintMatches(
  row: WebSearchResult,
  constraint: SearchSiteConstraint,
): boolean {
  if (!domainMatches(row.domain, constraint.domain)) return false;
  if (!constraint.pathPrefix) return true;
  try {
    return pathMatches(new URL(row.url).pathname, constraint.pathPrefix);
  } catch {
    return false;
  }
}

function filterSearchResults(
  rows: WebSearchResult[],
  request: NormalizedWebSearchRequest,
): WebSearchResult[] {
  if (!request.siteConstraints.length) return rows;
  return rows.filter((row) =>
    request.siteConstraints.some((constraint) =>
      siteConstraintMatches(row, constraint),
    ),
  );
}

function dedupeResults(
  rows: WebSearchResult[],
  limit: number,
): WebSearchResult[] {
  const seen = new Set<string>();
  const results: WebSearchResult[] = [];
  for (const row of rows) {
    const url = safeText(row?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push({ ...row, position: results.length + 1 });
    if (results.length >= limit) break;
  }
  return results;
}

function extractHref(attributes: string): string {
  return attributes.match(/\bhref=(['"])(.*?)\1/i)?.[2] || "";
}

function collectAnchorMatches(
  html: string,
  pattern: RegExp,
): Array<{ index: number; attributes: string; innerHtml: string }> {
  const matches: Array<{
    index: number;
    attributes: string;
    innerHtml: string;
  }> = [];
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(html))) {
    matches.push({
      index: match.index,
      attributes: match[1] || "",
      innerHtml: match[3] || "",
    });
  }
  return matches;
}

function isChallengePage(html: string): boolean {
  const text = String(html || "");
  return [
    /captcha/i,
    /unusual traffic/i,
    /automated queries/i,
    /sorry\/index/i,
    /robot check/i,
    /challenge-form/i,
  ].some((pattern) => pattern.test(text));
}

function unwrapGoogleUrl(rawUrl: string): string {
  const value = decodeHtmlEntities(String(rawUrl || "").trim());
  if (!value) return "";
  try {
    const url = new URL(value, "https://www.google.com");
    if (url.pathname === "/url") {
      const direct = url.searchParams.get("q");
      return direct ? decodeURIComponent(direct) : "";
    }
    if (
      url.pathname.startsWith("/search") ||
      url.pathname.startsWith("/settings")
    ) {
      return "";
    }
    return url.toString();
  } catch {
    return value;
  }
}

function unwrapDuckDuckGoUrl(rawUrl: string): string {
  const value = decodeHtmlEntities(String(rawUrl || "").trim());
  if (!value) return "";
  try {
    const url = new URL(
      value.startsWith("//") ? `https:${value}` : value,
      "https://duckduckgo.com",
    );
    const direct = url.searchParams.get("uddg");
    if (direct) return decodeURIComponent(direct);
    return url.toString();
  } catch {
    return value;
  }
}

export function parseGoogleResults(html: string, limit = 8): WebSearchResult[] {
  const rows: WebSearchResult[] = [];
  const source = String(html || "");
  const matches = collectAnchorMatches(
    source,
    /<a\b((?=[^>]*\bdata-ved=)(?![^>]*\bclass=)[^>]*\bhref=(["'])(?:\/url\?q=|https?:\/\/|\/)[\s\S]*?\2[^>]*)>([\s\S]*?)<\/a>/gi,
  );

  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const nextIndex = matches[index + 1]?.index ?? source.length;
    const segment = source.slice(current.index, nextIndex);
    const rawUrl = extractHref(current.attributes);
    const url = unwrapGoogleUrl(rawUrl);
    if (!url || hostOf(url).endsWith("google.com")) continue;

    const titleMatch = current.innerHtml.match(
      /<div\b[^>]*\bstyle=(["'])[^"']*\1[^>]*>([\s\S]*?)<\/div>/i,
    );
    const title = stripHtml(titleMatch?.[2] || current.innerHtml);
    if (!title || title.toLowerCase() === "cached") continue;

    const snippetMatch =
      segment.match(
        /<div\b[^>]*\bclass=(["'])(?=[^"']*\bilUpNd\b)(?=[^"']*\bH66NU\b)(?=[^"']*\baSRlid\b)[^"']*\1[^>]*>([\s\S]*?)<\/div>/i,
      ) ||
      segment.match(
        /<(?:div|span)\b[^>]*\bclass=(["'])[^"']*(?:VwiC3b|yXK7lf|s3v9rd|st)[^"']*\1[^>]*>([\s\S]*?)<\/(?:div|span)>/i,
      );

    const row = buildResultRow(
      url,
      title,
      stripHtml(snippetMatch?.[2] || ""),
      "google",
      rows.length + 1,
    );
    if (row) rows.push(row);
  }

  return dedupeResults(rows, limit);
}

export function parseDuckDuckGoLiteResults(
  html: string,
  limit = 8,
): WebSearchResult[] {
  const rows: WebSearchResult[] = [];
  const source = String(html || "");
  const htmlPattern =
    /<div\b[^>]*\bclass=['"][^'"]*web-result[^'"]*['"][^>]*>([\s\S]*?)(?=<div\b[^>]*\bclass=['"][^'"]*web-result[^'"]*['"]|<\/div>\s*<\/div>|$)/gi;
  let htmlMatch: RegExpExecArray | null = null;
  while ((htmlMatch = htmlPattern.exec(source))) {
    const segment = htmlMatch[1] || "";
    const titleMatch = segment.match(
      /<h2\b[\s\S]*?<a\b([^>]*)>([\s\S]*?)<\/a>/i,
    );
    const snippetMatch = segment.match(
      /<a\b[^>]*\bclass=['"][^'"]*result__snippet[^'"]*['"][^>]*>([\s\S]*?)<\/a>/i,
    );
    const row = buildResultRow(
      unwrapDuckDuckGoUrl(extractHref(titleMatch?.[1] || "")),
      stripHtml(titleMatch?.[2] || ""),
      stripHtml(snippetMatch?.[1] || ""),
      "duckduckgo",
      rows.length + 1,
    );
    if (row) rows.push(row);
  }

  const litePattern =
    /<a\b([^>]*\bclass=['"]result-link['"][^>]*)>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\b[^>]*\bclass=['"]result-link['"]|$)/gi;
  let liteMatch: RegExpExecArray | null = null;
  while ((liteMatch = litePattern.exec(source))) {
    const snippetMatch = liteMatch[3].match(
      /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i,
    );
    const row = buildResultRow(
      unwrapDuckDuckGoUrl(extractHref(liteMatch[1] || "")),
      stripHtml(liteMatch[2] || ""),
      stripHtml(snippetMatch?.[1] || ""),
      "duckduckgo",
      rows.length + 1,
    );
    if (row) rows.push(row);
  }
  return dedupeResults(rows, limit);
}

async function fetchGoogleHtml(request: NormalizedWebSearchRequest) {
  const url = buildGoogleUrl(request);
  try {
    const html = await fetchText(url, {
      headers: {
        Accept: "*/*",
        "Accept-Language": buildAcceptLanguage(request.language),
        Cookie: "CONSENT=YES+",
        Referer: new URL(url).origin + "/",
        "User-Agent": GOOGLE_GSA_USER_AGENT,
      },
    });
    if (isChallengePage(html)) {
      throw new Error("google_challenge_required");
    }
    return html;
  } catch (error: unknown) {
    if (isChallengePage(String(error))) {
      throw new Error("google_challenge_required");
    }
    throw error;
  }
}

async function searchGoogle(request: NormalizedWebSearchRequest) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const html = await fetchGoogleHtml(request);
      const results = filterSearchResults(
        parseGoogleResults(html, request.limit),
        request,
      );
      if (results.length > 0 || attempt > 0) return results;
    } catch (error: unknown) {
      const message = safeText(error instanceof Error ? error.message : error);
      if (message === "google_challenge_required") {
        throw error;
      }
      lastError = error;
      if (attempt > 0) throw error;
    }
  }
  if (lastError) throw lastError;
  return [];
}

async function searchDuckDuckGo(request: NormalizedWebSearchRequest) {
  const html = await fetchText(buildDuckDuckGoUrl(), {
    method: "POST",
    body: buildDuckDuckGoBody(request),
    headers: {
      "Accept-Language": buildAcceptLanguage(request.language),
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: buildDuckDuckGoCookie(request),
      Referer: "https://html.duckduckgo.com/",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-User": "?1",
      "User-Agent": DUCKDUCKGO_USER_AGENT,
    },
  });
  if (isChallengePage(html)) {
    throw new Error("duckduckgo_challenge_required");
  }
  return filterSearchResults(
    parseDuckDuckGoLiteResults(html, request.limit),
    request,
  );
}

const DIRECT_PROVIDER_HANDLERS: DirectProvider[] = [
  { name: "google", search: searchGoogle },
  { name: "duckduckgo", search: searchDuckDuckGo },
];

export async function searchWeb(
  input: WebSearchRequest,
): Promise<WebSearchResponse> {
  const request = normalizeSearchRequest(input);
  if (!request.q) throw new Error("web_search_query_required");

  const attempts: WebSearchAttempt[] = [];
  const collected: WebSearchResult[] = [];
  let primaryEngine = "";
  let lastError = "";

  for (const provider of DIRECT_PROVIDER_HANDLERS) {
    try {
      const results = await provider.search(request);
      attempts.push({
        engine: provider.name,
        ok: true,
        results: results.length,
      });
      if (results.length > 0) {
        if (!primaryEngine) primaryEngine = provider.name;
        collected.push(...results);
      }
      const merged = dedupeResults(collected, request.limit);
      if (merged.length >= request.limit) {
        return {
          ok: true,
          query: request.q,
          engine: primaryEngine || provider.name,
          attempts,
          results: merged,
        };
      }
      if (!lastError) lastError = "web_search_no_results";
    } catch (error: unknown) {
      lastError = safeText(
        error instanceof Error ? error.message : error || "web_search_failed",
      );
      attempts.push({ engine: provider.name, ok: false, error: lastError });
    }
  }

  const merged = dedupeResults(collected, request.limit);
  if (merged.length > 0) {
    return {
      ok: true,
      query: request.q,
      engine:
        primaryEngine || merged[0]?.engine || DIRECT_PROVIDER_HANDLERS[0].name,
      attempts,
      results: merged,
    };
  }

  return {
    ok: false,
    query: request.q,
    engine: primaryEngine || DIRECT_PROVIDER_HANDLERS[0].name,
    attempts,
    results: [],
    error: lastError || "web_search_no_results",
  };
}
