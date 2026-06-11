const SEARCH_TIMEOUT_MS = 8_000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; RinBrowse/1.0; +https://github.com/rinchan-hoshino/rin)";
const SUPPORTED_FRESHNESS = ["day", "week", "month", "year"] as const;

export const SEARXNG_BROWSE_PROVIDERS = [
  "google",
  "bing",
  "duckduckgo",
] as const;

export type BrowseFreshness = (typeof SUPPORTED_FRESHNESS)[number];

export type BrowseRequest = {
  q: string;
  limit?: number;
  domains?: string[];
  freshness?: BrowseFreshness;
  language?: string;
};

export type BrowseResult = {
  position: number;
  title: string;
  url: string;
  domain: string;
  snippet: string;
  engine: string;
  publishedDate: string;
};

export type BrowseAttempt = {
  engine: string;
  ok: boolean;
  results?: number;
  error?: string;
};

export type BrowseResponse = {
  ok: boolean;
  query: string;
  results: BrowseResult[];
  engine?: string;
  attempts?: BrowseAttempt[];
  error?: string;
};

type SearchSiteConstraint = {
  domain: string;
  pathPrefix: string;
};

type NormalizedBrowseRequest = {
  q: string;
  limit: number;
  domains: string[];
  siteConstraints: SearchSiteConstraint[];
  freshness?: BrowseFreshness;
  language: string;
};

type FetchTextOptions = {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit;
  timeoutMs?: number;
};

type SearxngEngine = (typeof SEARXNG_BROWSE_PROVIDERS)[number];

type SearxngResultRow = {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  description?: unknown;
  engine?: unknown;
  publishedDate?: unknown;
  published_date?: unknown;
};

type SearxngResponse = {
  results?: SearxngResultRow[];
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

function isSupportedFreshness(value: string): value is BrowseFreshness {
  return (SUPPORTED_FRESHNESS as readonly string[]).includes(value);
}

function normalizeLanguageHint(value: unknown): string {
  const language = safeText(value);
  if (!language) return "all";
  const normalized = language.replace(/_/g, "-");
  const [primary = "", ...rest] = normalized.split("-");
  if (!primary) return "all";
  return [
    primary.toLowerCase(),
    ...rest.map((part) =>
      part.length === 2 ? part.toUpperCase() : part.toLowerCase(),
    ),
  ].join("-");
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
  raw: BrowseRequest | null | undefined,
): NormalizedBrowseRequest {
  const q = safeText(raw?.q);
  const limit = Math.max(1, Math.min(8, Number(raw?.limit || 5) || 5));
  const language = normalizeLanguageHint(raw?.language);
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
        `fetch_failed url=${formatFetchUrl(response.url || url)} status=http_${response.status} ${truncateText(response.statusText, 80)} body=${truncateText(text || response.statusText)}`,
      );
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson<T>(
  url: string,
  options: FetchTextOptions = {},
): Promise<T | null> {
  const text = await fetchText(url, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });
  try {
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    throw new Error(`invalid_json url=${formatFetchUrl(url)}`);
  }
}

function buildResultRow(
  url: string,
  title: string,
  snippet: string,
  engine: string,
  position: number,
): BrowseResult | null {
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
  row: BrowseResult,
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
  rows: BrowseResult[],
  request: NormalizedBrowseRequest,
): BrowseResult[] {
  if (!request.siteConstraints.length) return rows;
  return rows.filter((row) =>
    request.siteConstraints.some((constraint) =>
      siteConstraintMatches(row, constraint),
    ),
  );
}

function dedupeResults(rows: BrowseResult[], limit: number): BrowseResult[] {
  const seen = new Set<string>();
  const results: BrowseResult[] = [];
  for (const row of rows) {
    const url = safeText(row?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push({ ...row, position: results.length + 1 });
    if (results.length >= limit) break;
  }
  return results;
}

function buildSearxngUrl(
  baseUrl: string,
  request: NormalizedBrowseRequest,
  engine: SearxngEngine,
): string {
  const url = new URL("/search", `${baseUrl}/`);
  url.searchParams.set("q", buildSearchQuery(request));
  url.searchParams.set("format", "json");
  url.searchParams.set("language", request.language);
  url.searchParams.set("safesearch", "0");
  url.searchParams.set("pageno", "1");
  url.searchParams.set("categories", "general");
  url.searchParams.set("engines", engine);
  if (request.freshness) {
    url.searchParams.set("time_range", request.freshness);
  }
  return url.toString();
}

function parseSearxngResults(
  data: SearxngResponse | null | undefined,
  engine: SearxngEngine,
  limit: number,
): BrowseResult[] {
  const rows = Array.isArray(data?.results) ? data.results : [];
  const results = rows
    .map((item, index) => {
      const row = buildResultRow(
        safeText(item?.url),
        safeText(item?.title),
        safeText(item?.content || item?.description),
        safeText(item?.engine) || engine,
        index + 1,
      );
      if (!row) return null;
      return {
        ...row,
        publishedDate: safeText(item?.publishedDate || item?.published_date),
      };
    })
    .filter((item): item is BrowseResult => Boolean(item));
  return dedupeResults(results, limit);
}

async function searchSearxngEngine(
  baseUrl: string,
  request: NormalizedBrowseRequest,
  engine: SearxngEngine,
): Promise<BrowseResult[]> {
  const url = buildSearxngUrl(baseUrl, request, engine);
  const data = await fetchJson<SearxngResponse>(url, {
    headers: { "User-Agent": USER_AGENT },
  });
  return filterSearchResults(
    parseSearxngResults(data, engine, request.limit),
    request,
  );
}

export async function searchWeb(
  baseUrl: string,
  input: BrowseRequest,
): Promise<BrowseResponse> {
  const request = normalizeSearchRequest(input);
  if (!request.q) throw new Error("browse_query_required");
  if (!safeText(baseUrl)) throw new Error("browse_sidecar_unavailable");

  const attempts: BrowseAttempt[] = [];
  let lastError = "";
  let hadOkAttempt = false;

  for (const engine of SEARXNG_BROWSE_PROVIDERS) {
    try {
      const results = await searchSearxngEngine(baseUrl, request, engine);
      attempts.push({ engine, ok: true, results: results.length });
      hadOkAttempt = true;
      if (results.length > 0) {
        return {
          ok: true,
          query: request.q,
          engine,
          attempts,
          results: dedupeResults(results, request.limit),
        };
      }
    } catch (error: unknown) {
      lastError = safeText(
        error instanceof Error ? error.message : error || "browse_failed",
      );
      attempts.push({ engine, ok: false, error: lastError });
    }
  }

  if (hadOkAttempt) {
    return {
      ok: true,
      query: request.q,
      engine: attempts.find((item) => item.ok)?.engine,
      attempts,
      results: [],
    };
  }

  return {
    ok: false,
    query: request.q,
    engine: SEARXNG_BROWSE_PROVIDERS[0],
    attempts,
    results: [],
    error: lastError || "browse_failed",
  };
}
