import fs from "node:fs";
import path from "node:path";

import {
  captureInternalRinCommand,
  createTargetExecutionContext,
  extractSubcommandArgv,
  ParsedArgs,
  safeString,
} from "./shared.js";
import { loadRinAgentRuntime } from "../rin-lib/agent-runtime.js";
import { nowIso } from "../time-utils.js";
import { formatReportTime, renderReportTable } from "./report-format.js";
import type { ChatMessagePart } from "../rin-lib/chat-outbox.js";
import type { TokenUsageQueryOptions } from "../token-usage/store.js";
import {
  formatProviderModelLabel,
  getTokenUsageOverview,
  listTokenUsageDimensions,
  queryTokenUsageAggregate,
  queryTokenUsageEvents,
} from "../token-usage/store.js";
import {
  buildUsageTrendSeries,
  renderUsageTrendTextChart,
  writeUsageTrendChartImage,
} from "./usage-chart.js";

export {
  buildUsageTrendSeries,
  renderUsageTrendTextChart,
  writeUsageTrendChartImage,
} from "./usage-chart.js";

export type UsageCliOptions = {
  from?: string;
  to?: string;
  groupBy: string[];
  filters: Array<{ key: string; value: string }>;
  limit: number;
  orderBy: string;
  direction: "asc" | "desc";
  events: boolean;
  includeZero: boolean;
  dimensions: boolean;
  json: boolean;
  allTime?: boolean;
  help: boolean;
};

type UsageScope = Pick<
  TokenUsageQueryOptions,
  "agentDir" | "from" | "to" | "filters"
>;

type UsageAggregateSection = {
  title: string;
  groupBy: string[];
  limit: number;
};

const DASHBOARD_AGGREGATE_SECTIONS: UsageAggregateSection[] = [
  { title: "top models", groupBy: ["provider_model"], limit: 8 },
  { title: "top sessions", groupBy: ["session"], limit: 10 },
  { title: "top capabilities", groupBy: ["capability"], limit: 10 },
  { title: "top hours", groupBy: ["hour"], limit: 8 },
];

const OPENAI_CODEX_PROVIDER = "openai-codex";
const ANTHROPIC_PROVIDER = "anthropic";
const GITHUB_COPILOT_PROVIDER = "github-copilot";
const OPENAI_CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const GITHUB_USER_URL = "https://api.github.com/user";
const GOOGLE_USERINFO_URL =
  "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const GOOGLE_OAUTH_PROVIDERS = new Set([
  "google-gemini-cli",
  "google-antigravity",
]);

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  [OPENAI_CODEX_PROVIDER]: "ChatGPT Codex",
  [ANTHROPIC_PROVIDER]: "Claude subscription",
  [GITHUB_COPILOT_PROVIDER]: "GitHub Copilot",
  "google-gemini-cli": "Gemini CLI",
  "google-antigravity": "Google Antigravity",
};

type SubscriptionWindow = {
  name: string;
  percentLeft?: number;
  resetAt?: string;
  windowSeconds?: number;
};

export type ProviderQuotaStatus = {
  provider: string;
  label: string;
  configured: boolean;
  authType?: string;
  accountName?: string;
  accountId?: string;
  plan?: string;
  windows: SubscriptionWindow[];
  credits?: string;
  error?: string;
};

export type CodexSubscriptionStatus = Omit<
  ProviderQuotaStatus,
  "provider" | "label"
>;

type ProviderCredential = {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
  projectId?: string;
  email?: string;
  enterpriseUrl?: string;
};

function printUsageHelp() {
  console.log(
    [
      "rin usage [options]",
      "",
      "Options:",
      "  --from <time>         start time (ISO, YYYY-MM-DD, 24h, 7d, 30m)",
      "  --to <time>           end time (ISO, YYYY-MM-DD, 24h, 7d, 30m)",
      "  --group-by <dims>     comma-separated dimensions",
      "  --filter <k=v>        equality filter, repeatable",
      "  --limit <n>           row limit (default 20)",
      "  --order-by <metric>   total_tokens, cost_total, rows, input_tokens...",
      "  --direction <dir>     asc or desc",
      "  --events              show raw events instead of aggregates",
      "  --include-zero        include zero-token rows in aggregates",
      "  --dimensions          list supported dimensions",
      "  --json                print an agent backend JSON report with quota and queried data",
      "  --all-time            query all stored history instead of the default 7d JSON range",
      "  --help                show this help",
      "",
      "The default frontend and range-less JSON report use the most recent 7d. Pass --all-time with --json to query all stored history.",
      "",
      "Examples:",
      "  rin usage",
      "  rin usage --json",
      "  rin usage --json --all-time",
      "  rin usage --group-by provider_model,capability --from 7d",
      "  rin usage --group-by session,capability --from 48h",
      "  rin usage --events --limit 50 --filter session_id=abc123",
    ].join("\n"),
  );
}

function parsePositiveInt(value: string, fallback: number) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.round(num);
}

function readUsageArg(args: string[], index: number): string {
  return safeString(args[index]).trim();
}

function parseGroupByArg(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseFilterArg(raw: string) {
  const eq = raw.indexOf("=");
  if (eq <= 0 || eq >= raw.length - 1) {
    throw new Error(`invalid_filter:${raw}`);
  }
  return {
    key: raw.slice(0, eq).trim(),
    value: raw.slice(eq + 1).trim(),
  };
}

function normalizeDirectionArg(value: string): "asc" | "desc" {
  return value.toLowerCase() === "asc" ? "asc" : "desc";
}

function normalizeTimeArg(
  input: string | undefined,
  boundary: "start" | "end",
) {
  const raw = safeString(input).trim();
  if (!raw) return undefined;
  const relative = raw.match(/^(\d+)([mhdw])$/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const now = Date.now();
    const deltaMs =
      unit === "m"
        ? amount * 60_000
        : unit === "h"
          ? amount * 3_600_000
          : unit === "d"
            ? amount * 86_400_000
            : amount * 7 * 86_400_000;
    return new Date(now - deltaMs).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return boundary === "start"
      ? `${raw}T00:00:00.000Z`
      : `${raw}T23:59:59.999Z`;
  }
  const date = new Date(raw);
  if (!Number.isNaN(date.getTime())) return date.toISOString();
  throw new Error(`invalid_time:${raw}`);
}

export function createDefaultUsageOptions(): UsageCliOptions {
  return {
    groupBy: [],
    filters: [],
    limit: 20,
    orderBy: "total_tokens",
    direction: "desc",
    events: false,
    includeZero: false,
    dimensions: false,
    json: false,
    allTime: false,
    help: false,
  };
}

export function parseUsageArgs(argv: string[]): UsageCliOptions {
  const args = extractSubcommandArgv(argv, "usage");
  const result: UsageCliOptions = createDefaultUsageOptions();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--events") {
      result.events = true;
      continue;
    }
    if (arg === "--include-zero") {
      result.includeZero = true;
      continue;
    }
    if (arg === "--dimensions") {
      result.dimensions = true;
      continue;
    }
    if (arg === "--json") {
      result.json = true;
      continue;
    }
    if (arg === "--all-time") {
      result.allTime = true;
      continue;
    }
    if (arg === "--from") {
      result.from = normalizeTimeArg(readUsageArg(args, ++i), "start");
      continue;
    }
    if (arg === "--to") {
      result.to = normalizeTimeArg(readUsageArg(args, ++i), "end");
      continue;
    }
    if (arg === "--group-by") {
      result.groupBy = parseGroupByArg(readUsageArg(args, ++i));
      continue;
    }
    if (arg === "--filter") {
      result.filters.push(parseFilterArg(readUsageArg(args, ++i)));
      continue;
    }
    if (arg === "--limit") {
      result.limit = parsePositiveInt(readUsageArg(args, ++i), result.limit);
      continue;
    }
    if (arg === "--order-by") {
      result.orderBy = readUsageArg(args, ++i) || result.orderBy;
      continue;
    }
    if (arg === "--direction") {
      result.direction = normalizeDirectionArg(readUsageArg(args, ++i));
      continue;
    }
    throw new Error(`unknown_usage_arg:${arg}`);
  }
  if (result.allTime && !result.json) {
    throw new Error("--all-time requires --json");
  }
  if (result.allTime && (result.from || result.to)) {
    throw new Error("--all-time cannot be combined with --from or --to");
  }
  if (
    result.json &&
    !result.dimensions &&
    !result.allTime &&
    !result.from &&
    !result.to
  ) {
    result.from = normalizeTimeArg("7d", "start");
  }
  return result;
}

function formatInt(value: unknown) {
  return Math.round(Number(value || 0)).toLocaleString("en-US");
}

function formatCost(value: unknown) {
  return Number(value || 0).toFixed(4);
}

function formatPercent(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  const rounded = Math.round(numeric * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function clampPercent(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return Math.min(100, Math.max(0, numeric));
}

function renderBar(value: unknown, width = 18) {
  const percent = clampPercent(value);
  if (percent === undefined) return `${"░".repeat(width)} -`;
  const filled = Math.round((percent / 100) * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)} ${formatPercent(percent)}`;
}

function decodeJwtPayload(token: string): Record<string, any> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

function getAuthPath(agentDir: string) {
  return path.join(agentDir || "", "auth.json");
}

function readStoredCredentials(agentDir: string) {
  const authPath = getAuthPath(agentDir);
  if (!authPath || !fs.existsSync(authPath)) return {};
  try {
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    if (!auth || typeof auth !== "object") return {};
    const credentials: Record<string, ProviderCredential> = {};
    for (const [provider, credential] of Object.entries(auth)) {
      if (!provider || !credential || typeof credential !== "object") continue;
      credentials[provider] = credential as ProviderCredential;
    }
    return credentials;
  } catch {
    return {};
  }
}

function providerLabel(provider: string) {
  return PROVIDER_DISPLAY_NAMES[provider] || provider;
}

function baseProviderStatus(
  provider: string,
  credential: ProviderCredential | undefined,
): ProviderQuotaStatus {
  return {
    provider,
    label: providerLabel(provider),
    configured: true,
    authType: safeString(credential?.type).trim() || undefined,
    windows: [],
  };
}

function profileFromCredential(
  provider: string,
  credential: ProviderCredential | undefined,
): Pick<ProviderQuotaStatus, "accountName" | "accountId" | "plan"> {
  if (provider === OPENAI_CODEX_PROVIDER) {
    const payload = credential?.access
      ? decodeJwtPayload(credential.access)
      : undefined;
    const auth = payload?.["https://api.openai.com/auth"];
    const profile = payload?.["https://api.openai.com/profile"];
    return {
      accountName:
        safeString(profile?.email || profile?.name).trim() || undefined,
      accountId:
        safeString(credential?.accountId || auth?.chatgpt_account_id).trim() ||
        undefined,
      plan: safeString(auth?.chatgpt_plan_type).trim() || undefined,
    };
  }
  if (GOOGLE_OAUTH_PROVIDERS.has(provider)) {
    return {
      accountName: safeString(credential?.email).trim() || undefined,
      accountId: safeString(credential?.projectId).trim() || undefined,
    };
  }
  return {};
}

function normalizeWindowName(name: string, windowSeconds: unknown) {
  const seconds = Number(windowSeconds || 0);
  if (seconds > 0 && seconds <= 6 * 3600) return "five_hour";
  if (seconds >= 6 * 24 * 3600) return "weekly";
  return name;
}

function epochToIso(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  const ms = numeric > 10 ** 11 ? numeric : numeric * 1000;
  return new Date(ms).toISOString();
}

function parseIsoTime(value: unknown) {
  const text = safeString(value).trim();
  if (!text) return undefined;
  const timestamp = Date.parse(text);
  if (Number.isNaN(timestamp)) return undefined;
  return new Date(timestamp).toISOString();
}

function parseLimitWindow(
  name: string,
  value: any,
): SubscriptionWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const window =
    !value.reset_at && !value.reset_time_ms && value.primary_window
      ? value.primary_window
      : value;
  if (!window || typeof window !== "object") return undefined;
  const percentLeft =
    clampPercent(window.percent_left ?? window.remaining_percent) ??
    clampPercent(
      window.used_percent === undefined
        ? undefined
        : 100 - Number(window.used_percent),
    );
  const resetAt = epochToIso(window.reset_at ?? window.reset_time_ms);
  const windowSeconds = Number(window.limit_window_seconds || 0) || undefined;
  return {
    name: normalizeWindowName(name, windowSeconds),
    percentLeft,
    resetAt,
    windowSeconds,
  };
}

function parseRateLimitWindows(rateLimit: any): SubscriptionWindow[] {
  const windows: SubscriptionWindow[] = [];
  const primary =
    parseLimitWindow("five_hour", rateLimit?.five_hour) ||
    parseLimitWindow("five_hour", rateLimit?.five_hour_limit) ||
    parseLimitWindow("five_hour", rateLimit?.primary_window) ||
    parseLimitWindow("five_hour", rateLimit?.primary);
  const secondary =
    parseLimitWindow("weekly", rateLimit?.weekly) ||
    parseLimitWindow("weekly", rateLimit?.weekly_limit) ||
    parseLimitWindow("weekly", rateLimit?.secondary_window) ||
    parseLimitWindow("weekly", rateLimit?.secondary);
  if (primary) windows.push(primary);
  if (secondary) windows.push(secondary);
  return windows;
}

function parseAnthropicWindow(
  name: string,
  value: any,
): SubscriptionWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const utilization = Number(value.utilization);
  const percentLeft = Number.isFinite(utilization)
    ? clampPercent(100 - utilization)
    : clampPercent(value.percent_left ?? value.remaining_percent);
  return {
    name,
    percentLeft,
    resetAt: parseIsoTime(value.resets_at || value.reset_at),
  };
}

export function parseCodexSubscriptionUsage(
  data: any,
  credential?: ProviderCredential,
): CodexSubscriptionStatus {
  const fallback = profileFromCredential(OPENAI_CODEX_PROVIDER, credential);
  return {
    configured: true,
    accountName: safeString(data?.email).trim() || fallback.accountName,
    accountId:
      safeString(data?.account_id || data?.accountId).trim() ||
      fallback.accountId,
    plan: safeString(data?.plan_type || data?.planType).trim() || fallback.plan,
    windows: parseRateLimitWindows(data?.rate_limit || data?.rate_limits),
    credits: data?.credits
      ? safeString(data.credits.balance).trim()
      : undefined,
  };
}

export function parseAnthropicSubscriptionUsage(
  data: any,
): Pick<ProviderQuotaStatus, "windows" | "credits"> {
  const windows = [
    parseAnthropicWindow("five_hour", data?.five_hour),
    parseAnthropicWindow("seven_day", data?.seven_day),
  ].filter((window): window is SubscriptionWindow => Boolean(window));
  const usedCredits = data?.extra_usage?.used_credits;
  const monthlyLimit = data?.extra_usage?.monthly_limit;
  const credits =
    usedCredits !== undefined && monthlyLimit !== undefined
      ? `${(Number(usedCredits) / 100).toFixed(2)}/${(Number(monthlyLimit) / 100).toFixed(2)}`
      : undefined;
  return { windows, credits };
}

async function refreshProviderCredential(
  agentDir: string,
  provider: string,
  credential: ProviderCredential,
): Promise<ProviderCredential> {
  const authPath = getAuthPath(agentDir);
  if (!authPath || !fs.existsSync(authPath)) return credential;
  try {
    const agentRuntimeModule = await loadRinAgentRuntime();
    const { AuthStorage } = agentRuntimeModule as any;
    const authStorage = AuthStorage.create(authPath);
    const apiKey = await authStorage.getApiKey?.(provider, {
      includeFallback: false,
    });
    const refreshed = { ...credential, ...(authStorage.get?.(provider) || {}) };
    if (GOOGLE_OAUTH_PROVIDERS.has(provider) && typeof apiKey === "string") {
      try {
        const parsed = JSON.parse(apiKey);
        return {
          ...refreshed,
          access: parsed.token || refreshed.access,
          projectId: parsed.projectId || refreshed.projectId,
        };
      } catch {
        return refreshed;
      }
    }
    return { ...refreshed, access: apiKey || refreshed.access };
  } catch {
    return credential;
  }
}

async function readJsonResponse(url: string, init: RequestInit) {
  const response = await fetch(url, {
    ...init,
    signal: init.signal || AbortSignal.timeout(4000),
  });
  const text = await response.text();
  let data: any = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  return { response, data };
}

async function loadCodexProviderStatus(
  credential: ProviderCredential,
): Promise<ProviderQuotaStatus> {
  const profile = profileFromCredential(OPENAI_CODEX_PROVIDER, credential);
  const base = {
    ...baseProviderStatus(OPENAI_CODEX_PROVIDER, credential),
    ...profile,
  };
  if (!credential.access || !profile.accountId) {
    return { ...base, error: "missing token" };
  }
  try {
    const { response, data } = await readJsonResponse(OPENAI_CODEX_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${credential.access}`,
        Accept: "application/json",
        "ChatGPT-Account-Id": profile.accountId,
        Origin: "https://chatgpt.com",
        Referer: "https://chatgpt.com/",
        "User-Agent": "Rin usage",
      },
    });
    if (!response.ok)
      return { ...base, error: `quota HTTP ${response.status}` };
    return {
      ...base,
      ...parseCodexSubscriptionUsage(data, credential),
    };
  } catch (error: any) {
    return {
      ...base,
      error: safeString(error?.message || error).trim() || "quota unavailable",
    };
  }
}

async function loadAnthropicProviderStatus(
  credential: ProviderCredential,
): Promise<ProviderQuotaStatus> {
  const base = baseProviderStatus(ANTHROPIC_PROVIDER, credential);
  if (!credential.access) return { ...base, error: "missing token" };
  try {
    const { response, data } = await readJsonResponse(ANTHROPIC_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${credential.access}`,
        Accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "Rin usage",
      },
    });
    if (!response.ok)
      return { ...base, error: `quota HTTP ${response.status}` };
    return { ...base, ...parseAnthropicSubscriptionUsage(data) };
  } catch (error: any) {
    return {
      ...base,
      error: safeString(error?.message || error).trim() || "quota unavailable",
    };
  }
}

async function loadGoogleProviderStatus(
  provider: string,
  credential: ProviderCredential,
): Promise<ProviderQuotaStatus> {
  const base = loadUnavailableProviderStatus(provider, credential);
  if (!credential.access || base.accountName) return base;
  try {
    const { response, data } = await readJsonResponse(GOOGLE_USERINFO_URL, {
      headers: {
        Authorization: `Bearer ${credential.access}`,
        Accept: "application/json",
        "User-Agent": "Rin usage",
      },
    });
    if (!response.ok) return base;
    return {
      ...base,
      accountName: safeString(data?.email || data?.name).trim() || undefined,
      accountId: base.accountId,
    };
  } catch {
    return base;
  }
}

async function loadGithubCopilotProviderStatus(
  credential: ProviderCredential,
): Promise<ProviderQuotaStatus> {
  const base = baseProviderStatus(GITHUB_COPILOT_PROVIDER, credential);
  const token = credential.refresh;
  if (!token) return { ...base, error: "quota unavailable" };
  try {
    const { response, data } = await readJsonResponse(GITHUB_USER_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Rin usage",
      },
    });
    if (!response.ok) return { ...base, error: "quota unavailable" };
    return {
      ...base,
      accountName: safeString(data?.login || data?.email).trim() || undefined,
      accountId: safeString(data?.id).trim() || undefined,
      error: "quota unavailable",
    };
  } catch {
    return { ...base, error: "quota unavailable" };
  }
}

function loadUnavailableProviderStatus(
  provider: string,
  credential: ProviderCredential,
): ProviderQuotaStatus {
  return {
    ...baseProviderStatus(provider, credential),
    ...profileFromCredential(provider, credential),
    error: "quota unavailable",
  };
}

async function loadProviderQuotaStatus(
  agentDir: string,
  provider: string,
  credential: ProviderCredential,
): Promise<ProviderQuotaStatus> {
  const refreshed =
    credential.type === "oauth"
      ? await refreshProviderCredential(agentDir, provider, credential)
      : credential;
  if (refreshed.type !== "oauth") {
    return loadUnavailableProviderStatus(provider, refreshed);
  }
  if (provider === OPENAI_CODEX_PROVIDER) {
    return loadCodexProviderStatus(refreshed);
  }
  if (provider === ANTHROPIC_PROVIDER) {
    return loadAnthropicProviderStatus(refreshed);
  }
  if (GOOGLE_OAUTH_PROVIDERS.has(provider)) {
    return loadGoogleProviderStatus(provider, refreshed);
  }
  if (provider === GITHUB_COPILOT_PROVIDER) {
    return loadGithubCopilotProviderStatus(refreshed);
  }
  return loadUnavailableProviderStatus(provider, refreshed);
}

export async function loadProviderQuotaStatuses(
  agentDir: string,
): Promise<ProviderQuotaStatus[]> {
  const credentials = readStoredCredentials(agentDir);
  const entries = Object.entries(credentials).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return await Promise.all(
    entries.map(([provider, credential]) =>
      loadProviderQuotaStatus(agentDir, provider, credential),
    ),
  );
}

export async function loadCodexSubscriptionStatus(
  agentDir: string,
): Promise<CodexSubscriptionStatus> {
  const credential = readStoredCredentials(agentDir)[OPENAI_CODEX_PROVIDER];
  if (credential?.type !== "oauth") return { configured: false, windows: [] };
  const refreshed = await refreshProviderCredential(
    agentDir,
    OPENAI_CODEX_PROVIDER,
    credential,
  );
  const status = await loadCodexProviderStatus(refreshed);
  const { configured, accountName, accountId, plan, windows, credits, error } =
    status;
  return { configured, accountName, accountId, plan, windows, credits, error };
}

function providerQuotaHasUsagePercent(status: ProviderQuotaStatus) {
  return status.windows.some((window) => Number.isFinite(window.percentLeft));
}

function assertChatUsageQuotaReady(statuses: ProviderQuotaStatus[]) {
  const codexStatus = statuses.find(
    (status) => status.provider === OPENAI_CODEX_PROVIDER && status.configured,
  );
  if (!codexStatus) return;
  if (codexStatus.error) {
    throw new Error(`Codex usage unavailable: ${codexStatus.error}`);
  }
  if (!providerQuotaHasUsagePercent(codexStatus)) {
    throw new Error("Codex usage unavailable: usage percentage missing");
  }
}

function renderProviderQuotaImageLines(statuses?: ProviderQuotaStatus[]) {
  if (!statuses) return ["ACCOUNTS QUOTA", "NOT CHECKED"];
  if (!statuses.length) return ["ACCOUNTS QUOTA", "NO CONFIGURED PROVIDERS"];
  const lines = ["ACCOUNTS QUOTA"];
  for (const status of statuses) {
    const plan = status.plan ? ` ${status.plan}` : "";
    lines.push(`${status.label}${plan}`);
    if (status.windows.length) {
      for (const window of status.windows) {
        const label =
          window.name === "five_hour"
            ? "5-HOUR"
            : window.name === "seven_day"
              ? "7-DAY"
              : window.name.replace(/_/g, "-").toUpperCase();
        const percent = Number.isFinite(window.percentLeft)
          ? `${Math.round(Number(window.percentLeft))}%`
          : "--%";
        lines.push(
          `${label} ${percent} LEFT RESET ${formatReportTime(window.resetAt)}`,
        );
      }
    } else {
      lines.push(`QUOTA UNAVAILABLE${status.error ? ` ${status.error}` : ""}`);
    }
    if (status.credits) lines.push(`CREDITS ${status.credits}`);
  }
  return lines;
}

function formatQuotaWindowLabel(name: string) {
  if (name === "five_hour") return "5-hour";
  if (name === "seven_day") return "7-day";
  return name;
}

function renderProviderQuotas(statuses?: ProviderQuotaStatus[]) {
  if (!statuses) return "Accounts & quota\nNot checked";
  if (!statuses.length) return "Accounts & quota\nNo configured providers";
  const blocks: string[] = [];
  for (const status of statuses) {
    const lines = [status.label];
    const account = status.accountName || status.accountId || "-";
    const plan = status.plan ? ` (${status.plan})` : "";
    lines.push(`${account}${plan}`);
    if (status.windows.length) {
      lines.push("");
      for (const window of status.windows) {
        lines.push(
          `[${formatQuotaWindowLabel(window.name)}] ${renderBar(window.percentLeft, 9)} left`,
        );
        lines.push(`— reset ${formatReportTime(window.resetAt)}`);
      }
    } else {
      lines.push(
        "",
        `Quota temporarily unavailable${status.error ? ` (${status.error})` : ""}`,
      );
    }
    if (status.credits) lines.push("", `Credits ${status.credits}`);
    blocks.push(lines.join("\n"));
  }
  return ["Accounts & quota", blocks.join("\n\n")].join("\n");
}

function summarizeOverview(overview: any) {
  const totalTokens = Number(overview?.total_tokens || 0);
  const tokenRows = [
    { label: "input", value: Number(overview?.input_tokens || 0) },
    { label: "output", value: Number(overview?.output_tokens || 0) },
    { label: "cache read", value: Number(overview?.cache_read_tokens || 0) },
    { label: "cache write", value: Number(overview?.cache_write_tokens || 0) },
  ].filter((row) => row.value > 0 || totalTokens === 0);
  const lines = [
    `overview`,
    `  events   ${formatInt(overview?.total_events)} total · ${formatInt(overview?.token_events)} token events`,
    `  scope    ${formatInt(overview?.session_count)} sessions · ${formatInt(overview?.model_count)} models`,
    `  tokens   ${formatInt(totalTokens)}`,
    ...tokenRows.map((row) => {
      const share = totalTokens > 0 ? (row.value / totalTokens) * 100 : 0;
      return `  ${row.label.padEnd(11)} ${renderBar(share, 14)} · ${formatInt(row.value)}`;
    }),
    `  cost     $${formatCost(overview?.cost_total)}`,
  ];
  if (
    safeString(overview?.first_timestamp).trim() ||
    safeString(overview?.last_timestamp).trim()
  ) {
    lines.push(
      `  range    ${safeString(overview?.first_timestamp).trim() || "-"} .. ${safeString(overview?.last_timestamp).trim() || "-"}`,
    );
  }
  return lines.join("\n");
}

function renderAggregateTable(
  title: string,
  groupBy: string[],
  rows: Array<Record<string, unknown>>,
) {
  const metrics = [
    "rows",
    "token_events",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "total_tokens",
    "cost_total",
  ];
  const maxTokens = Math.max(
    0,
    ...rows.map((row) => Number(row.total_tokens || 0)),
  );
  const formatted = rows.map((row) => {
    const next: Record<string, unknown> = {};
    for (const key of groupBy) next[key] = row[key];
    const totalTokens = Number(row.total_tokens || 0);
    next.chart = renderBar(
      maxTokens > 0 ? (totalTokens / maxTokens) * 100 : 0,
      10,
    );
    next.rows = formatInt(row.rows);
    next.token_events = formatInt(row.token_events);
    next.input_tokens = formatInt(row.input_tokens);
    next.output_tokens = formatInt(row.output_tokens);
    next.cache_read_tokens = formatInt(row.cache_read_tokens);
    next.cache_write_tokens = formatInt(row.cache_write_tokens);
    next.total_tokens = formatInt(row.total_tokens);
    next.cost_total = `$${formatCost(row.cost_total)}`;
    return next;
  });
  return `${title}\n${renderReportTable(formatted, [...groupBy, "chart", ...metrics])}`;
}

function renderEventTable(rows: Array<Record<string, unknown>>) {
  const formatted = rows.map((row) => ({
    timestamp: safeString(row.timestamp)
      .replace("T", " ")
      .replace(".000Z", "Z"),
    session_id: row.session_id,
    event_type: row.event_type,
    provider_model: formatProviderModelLabel(row.provider, row.model),
    capability: row.capability_key,
    tool_name: row.tool_name,
    message_role: row.message_role,
    total_tokens: formatInt(row.total_tokens),
    cost_total: `$${formatCost(row.cost_total)}`,
    stop_reason: row.stop_reason,
  }));
  return renderReportTable(formatted, [
    "timestamp",
    "session_id",
    "event_type",
    "provider_model",
    "capability",
    "tool_name",
    "message_role",
    "total_tokens",
    "cost_total",
    "stop_reason",
  ]);
}

function buildUsageScope(
  agentDir: string,
  options: UsageCliOptions,
): UsageScope {
  return {
    agentDir,
    from: options.from,
    to: options.to,
    filters: options.filters,
  };
}

function queryDashboardAggregate(
  scope: UsageScope,
  section: UsageAggregateSection,
): Array<Record<string, unknown>> {
  return queryTokenUsageAggregate({
    ...scope,
    groupBy: section.groupBy,
    limit: section.limit,
  });
}

function queryRecentMessageEvents(
  scope: UsageScope,
  limit: number,
): Array<Record<string, unknown>> {
  return queryTokenUsageEvents({
    ...scope,
    filters: [...scope.filters, { key: "event_type", value: "message_end" }],
    limit,
  }).filter((row) => Number(row.total_tokens || 0) > 0);
}

function renderUsageFrontendReport(
  agentDir: string,
  providerQuotas?: ProviderQuotaStatus[],
  options: { includeTrendChart?: boolean } = {},
) {
  const sections = [
    `Rin usage @ ${formatReportTime(nowIso())}`,
    renderProviderQuotas(providerQuotas),
  ];
  if (options.includeTrendChart !== false) {
    sections.push(
      "",
      renderUsageTrendTextChart(buildUsageTrendSeries(agentDir)),
    );
  }
  return sections.join("\n");
}

function isUsageBackendRequest(options: UsageCliOptions) {
  return Boolean(
    options.json ||
    options.dimensions ||
    options.events ||
    options.groupBy.length > 0 ||
    options.from ||
    options.to ||
    options.filters.length > 0 ||
    options.includeZero,
  );
}

function buildUsageBackendJson(
  agentDir: string,
  options: UsageCliOptions,
  providerQuotas?: ProviderQuotaStatus[],
) {
  const scope = buildUsageScope(agentDir, options);
  const base = {
    schemaVersion: 1,
    generatedAt: nowIso(),
    filters: {
      from: options.from,
      to: options.to,
      groupBy: options.groupBy,
      filters: options.filters,
      limit: options.limit,
      orderBy: options.orderBy,
      direction: options.direction,
      includeZero: options.includeZero,
      allTime: options.allTime,
    },
    providerQuotas: providerQuotas || [],
    dimensions: listTokenUsageDimensions(),
  };
  if (options.dimensions) return base;
  if (options.events) {
    return {
      ...base,
      events: queryTokenUsageEvents({ ...scope, limit: options.limit }),
    };
  }
  if (options.groupBy.length > 0) {
    return {
      ...base,
      aggregate: queryTokenUsageAggregate({
        ...scope,
        groupBy: options.groupBy,
        limit: options.limit,
        orderBy: options.orderBy,
        direction: options.direction,
        includeZero: options.includeZero,
      }),
    };
  }
  return {
    ...base,
    overview: getTokenUsageOverview(scope),
    aggregates: DASHBOARD_AGGREGATE_SECTIONS.map((section) => ({
      title: section.title,
      groupBy: section.groupBy,
      rows: queryDashboardAggregate(scope, section),
    })),
    recentTokenEvents: queryRecentMessageEvents(scope, 10),
  };
}

export function renderUsageReport(
  agentDir: string,
  options: UsageCliOptions,
  providerQuotas?: ProviderQuotaStatus[],
): string {
  if (options.help) {
    printUsageHelp();
    return "";
  }
  if (options.json) {
    return JSON.stringify(
      buildUsageBackendJson(agentDir, options, providerQuotas),
      null,
      2,
    );
  }
  if (options.dimensions) {
    return [
      "supported dimensions:",
      ...listTokenUsageDimensions().map((item) => `- ${item}`),
    ].join("\n");
  }
  const scope = buildUsageScope(agentDir, options);
  if (!isUsageBackendRequest(options)) {
    return renderUsageFrontendReport(agentDir, providerQuotas);
  }
  if (options.events) {
    return renderEventTable(
      queryTokenUsageEvents({ ...scope, limit: options.limit }),
    );
  }
  if (options.groupBy.length > 0) {
    const rows = queryTokenUsageAggregate({
      ...scope,
      groupBy: options.groupBy,
      limit: options.limit,
      orderBy: options.orderBy,
      direction: options.direction,
      includeZero: options.includeZero,
    });
    return renderAggregateTable("aggregate", options.groupBy, rows);
  }

  const overview = getTokenUsageOverview(scope);
  const aggregateSections = DASHBOARD_AGGREGATE_SECTIONS.map((section) =>
    renderAggregateTable(
      section.title,
      section.groupBy,
      queryDashboardAggregate(scope, section),
    ),
  );
  const recent = queryRecentMessageEvents(scope, 10);

  return [
    `Rin usage @ ${formatReportTime(nowIso())}`,
    renderProviderQuotas(providerQuotas),
    "",
    summarizeOverview(overview),
    "",
    ...aggregateSections.flatMap((section) => [section, ""]),
    "recent token events",
    renderEventTable(recent),
  ].join("\n");
}

export async function renderCompactUsageReportForChat(
  agentDir: string,
): Promise<string> {
  const providerQuotas = await loadProviderQuotaStatuses(agentDir);
  return renderUsageFrontendReport(agentDir, providerQuotas, {
    includeTrendChart: false,
  });
}

export async function renderUsageReportForChat(agentDir: string): Promise<{
  text: string;
  parts: ChatMessagePart[];
}> {
  const providerQuotas = await loadProviderQuotaStatuses(agentDir);
  assertChatUsageQuotaReady(providerQuotas);
  const imagePath = writeUsageTrendChartImage(agentDir, {
    quotaLines: renderProviderQuotaImageLines(providerQuotas),
  });
  return {
    text: "",
    parts: [{ type: "image", path: imagePath, mimeType: "image/png" }],
  };
}

async function renderUsageReportForCli(
  agentDir: string,
  options: UsageCliOptions,
) {
  if (options.json || !isUsageBackendRequest(options)) {
    const providerQuotas = await loadProviderQuotaStatuses(agentDir);
    return renderUsageReport(agentDir, options, providerQuotas);
  }
  return renderUsageReport(agentDir, options);
}

export async function runUsageInternal(rawArgv: string[]) {
  const options = parseUsageArgs(rawArgv);
  if (options.help) {
    printUsageHelp();
    return;
  }
  console.log(
    await renderUsageReportForCli(process.env.RIN_DIR || "", options),
  );
}

export async function runUsage(parsed: ParsedArgs, rawArgv: string[]) {
  const options = parseUsageArgs(rawArgv);
  if (options.help) {
    printUsageHelp();
    return;
  }
  const context = createTargetExecutionContext(parsed);
  if (!context.isTargetUser) {
    const forwarded = captureInternalRinCommand(
      context,
      "__usage_internal",
      rawArgv,
      "usage",
    );
    process.stdout.write(forwarded);
    return;
  }
  console.log(await renderUsageReportForCli(context.installDir, options));
}
