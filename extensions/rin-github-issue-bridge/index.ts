/* global process, setTimeout, clearTimeout */
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_BOT_ID = "github-issue-bridge";
const DEFAULT_BOT_LOGIN = "github-issue-bridge";
const DEFAULT_WORKING_LABEL = "rin:doing";
const SETTINGS_CONFIG_KEY = "githubIssueBridge";

function text(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}
function iso() {
  return new Date().toISOString();
}
function ms(value) {
  const n = Date.parse(text(value));
  return Number.isFinite(n) ? n : 0;
}
function mkdir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  mkdir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function parseRepo(value) {
  const [owner, repo] = text(value).trim().split("/");
  return owner && repo ? { owner, repo, fullName: `${owner}/${repo}` } : null;
}
function scopeKeyFor(repo, kind, number) {
  return `${repo.fullName}#${kind}/${Number(number)}`;
}
function configFromSettings(ctx) {
  const settings =
    readJson(path.join(path.dirname(ctx.dataDir), "settings.json"), {}) || {};
  const value = settings?.[SETTINGS_CONFIG_KEY];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return {};
}
function parseConfig(ctx) {
  return {
    ...configFromSettings(ctx),
    ...(ctx.config && typeof ctx.config === "object" ? ctx.config : {}),
  };
}
function tokenFrom(config) {
  const configured =
    text(config.token).trim() ||
    text(config.githubToken).trim() ||
    text(process.env.GITHUB_TOKEN).trim();
  if (configured) return configured;
  try {
    return execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}
function stateDefaults() {
  return {
    version: 2,
    bootstrappedAt: iso(),
    lastPolledAt: "",
    lastPollStartedAt: "",
    lastPollHeartbeatAt: "",
    lastPollFinishedAt: "",
    processed: {},
    scopes: {},
  };
}
function normalizeState(value) {
  return {
    ...stateDefaults(),
    ...(value && typeof value === "object" ? value : {}),
    processed:
      value?.processed && typeof value.processed === "object"
        ? value.processed
        : {},
    scopes:
      value?.scopes && typeof value.scopes === "object" ? value.scopes : {},
  };
}
function cleanSegment(value, fallback = "item") {
  const out = text(value)
    .replace(/[\\/:*?"<>|#]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return out || fallback;
}
function extForMime(mime) {
  return (
    {
      "image/jpeg": ".jpg",
      "image/jpg": ".jpg",
      "image/png": ".png",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "image/svg+xml": ".svg",
    }[text(mime).split(";", 1)[0].toLowerCase()] || ""
  );
}
function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map(contentText).filter(Boolean).join("\n");
  if (content?.attrs?.content) return text(content.attrs.content);
  if (content?.text) return text(content.text);
  return "";
}
function normalizeTrust(value) {
  const trust = text(value).trim().toUpperCase();
  return trust === "OWNER" || trust === "TRUSTED" ? trust : "OTHER";
}
function loadIdentity(dataDir) {
  return (
    readJson(path.join(dataDir, "identity.json"), {
      persons: {},
      aliases: [],
      trusted: [],
    }) || { persons: {}, aliases: [], trusted: [] }
  );
}
function identityTrustOf(identity, platform, userId) {
  const nextPlatform = text(platform).trim();
  const nextUserId = text(userId).trim();
  if (!nextPlatform || !nextUserId) return "OTHER";
  const alias = (Array.isArray(identity?.aliases) ? identity.aliases : []).find(
    (entry) =>
      text(entry?.platform).trim() === nextPlatform &&
      text(entry?.userId).trim() === nextUserId,
  );
  const personId = text(alias?.personId).trim();
  return personId
    ? normalizeTrust(identity?.persons?.[personId]?.trust)
    : "OTHER";
}
function canAccessGithubActor(dataDir, login) {
  const trust = identityTrustOf(loadIdentity(dataDir), "github", login);
  return trust === "OWNER" || trust === "TRUSTED";
}
function commentUrlParts(url) {
  const m = text(url).match(
    /github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)#issuecomment-(\d+)/,
  );
  return m
    ? { owner: m[1], repo: m[2], number: Number(m[3]), commentId: Number(m[4]) }
    : null;
}
function issueBody(issue) {
  return text(issue?.body).trim();
}
function latest(items) {
  return items.filter(Boolean).sort((a, b) => ms(b.at) - ms(a.at))[0] || null;
}
function looksInterim(value) {
  return text(value).trim().startsWith("···");
}
function looksPassiveNotice(value) {
  const v = text(value)
    .trim()
    .replace(/^💡\s*/, "");
  return /^Self-improve review (queued|skipped|failed|completed|updated)\b/.test(
    v,
  );
}
function looksUsableFinal(value) {
  const v = text(value).trim();
  if (!v || looksInterim(v) || looksPassiveNotice(v)) return false;
  if (
    /^(主人|主理人|黑夜哥哥)，?\s*(收到|我先|铃酱先|正在|继续看|继续查)/.test(v)
  )
    return false;
  return true;
}
function withSignal(params, signal) {
  return { ...params, request: { ...(params?.request || {}), signal } };
}
function octokitRuntimeOptions(auth, timeout) {
  return {
    auth,
    request: { timeout },
    retry: { enabled: false },
    throttle: { enabled: false },
  };
}

export default function githubIssueBridgeExtension(rin) {
  const bridge = createGithubIssueBridge({ context: rin });
  rin.registerChatAdapter((input) => bridge.adapterProvider(input), {
    key: "github",
    name: "github",
    config: rin.config,
  });
  rin.registerBackgroundService({
    start() {
      bridge.start();
      return { stop: () => bridge.stop() };
    },
  });
}

export function createGithubIssueBridge(options) {
  const ctx = options.context;
  const config = parseConfig(ctx);
  const botId = text(config.botId || DEFAULT_BOT_ID).trim();
  const botLogin = text(config.botLogin || DEFAULT_BOT_LOGIN).trim();
  const workingLabel = text(
    config.workingLabel || config.bridgeWorkingLabel || DEFAULT_WORKING_LABEL,
  ).trim();
  const mergeFanoutChatKeys = (
    Array.isArray(config.mergeFanoutChatKeys)
      ? config.mergeFanoutChatKeys
      : [config.mergeFanoutChatKey]
  )
    .map((item) => text(item).trim())
    .filter(Boolean);
  const closeShutdownEnabled = config.closeShutdownEnabled !== false;
  const requestTimeoutMs = Math.max(
    5_000,
    Number(config.requestTimeoutMs || config.bridgeRequestTimeoutMs || 30_000),
  );
  const pollIntervalMs = Math.max(
    10_000,
    Number(config.pollIntervalMs || config.bridgePollIntervalMs || 60_000),
  );
  const tickWarnMs = Math.max(
    requestTimeoutMs + 10_000,
    Number(config.tickTimeoutMs || config.bridgeTickTimeoutMs || 120_000),
  );
  const maxConcurrentScopes = Math.max(
    0,
    Number(config.maxConcurrentScopes ?? config.bridgeMaxConcurrentScopes ?? 3),
  );
  const scanIssueLimit = Math.max(
    1,
    Number(config.scanIssueLimit || config.bridgeScanIssueLimit || 25),
  );
  const scanBudgetMs = Math.max(
    10_000,
    Number(
      config.scanBudgetMs ||
        config.bridgeScanBudgetMs ||
        Math.min(45_000, requestTimeoutMs * 2),
    ),
  );
  const orgScanRepoLimit = Math.max(
    1,
    Number(config.orgScanRepoLimit || config.bridgeOrgScanRepoLimit || 1),
  );
  const closedScanIssueLimit = Math.max(
    1,
    Number(
      config.closedScanIssueLimit ||
        config.bridgeClosedScanIssueLimit ||
        scanIssueLimit,
    ),
  );
  const closedScanBudgetMs = Math.max(
    10_000,
    Number(
      config.closedScanBudgetMs ||
        config.bridgeClosedScanBudgetMs ||
        scanBudgetMs,
    ),
  );
  const orphanActiveMs = Math.max(
    60_000,
    Number(config.orphanActiveScopeRetryMs || 90_000),
  );
  const staleFreshMs = Math.max(
    60_000,
    Number(config.staleSessionlessRetryMs || 10 * 60_000),
  );
  const repos = (
    Array.isArray(config.repositories)
      ? config.repositories
      : [config.repository || config.repo]
  )
    .map(parseRepo)
    .filter(Boolean);
  const repoMap = new Map(repos.map((r) => [r.fullName, r]));
  const issueOrgBaselines = Object.fromEntries(
    Object.entries(config.issueOrgBaselines || {})
      .map(([org, at]) => [text(org).trim(), text(at).trim()])
      .filter(([org, at]) => org && ms(at)),
  );
  const token = tokenFrom(config);
  const agentDir = path.dirname(ctx.dataDir);
  const dataDir = path.join(
    ctx.dataDir,
    "extensions",
    "state",
    "rin-github-issue-bridge",
  );
  const stateFile =
    text(config.stateFile || config.bridgeStateFile).trim() ||
    path.join(dataDir, "state.json");
  const mediaDir = path.join(dataDir, "media");
  const state = normalizeState(readJson(stateFile, {}));
  let octokit = options.octokit || null;
  let app = null;
  let stopped = false;
  let ticking = false;
  let tickStartedAt = 0;
  let tickWarned = false;

  function save() {
    writeJson(stateFile, state);
  }
  function storedSessionPath(sessionFile) {
    const v = text(sessionFile).trim();
    return !v
      ? ""
      : path.isAbsolute(v)
        ? v
        : path.join(agentDir, "sessions", v);
  }
  function sessionIdFromFile(file) {
    return path.basename(text(file), ".jsonl");
  }
  function usableSessionFile(file) {
    const v = text(file).trim();
    return v && fs.existsSync(storedSessionPath(v)) ? v : "";
  }
  function chatStateFile(scopeKey) {
    return path.join(
      ctx.dataDir,
      "chat",
      "session-state",
      "github",
      `private:${scopeKey}`,
      "state.json",
    );
  }
  function chatStateSession(scopeKey) {
    return usableSessionFile(
      readJson(chatStateFile(scopeKey), {})?.sessionFile,
    );
  }
  function recordsSession(scopeKey, messageId = "") {
    const root = path.join(ctx.dataDir, "chat", "message-store", "records");
    if (!fs.existsSync(root)) return "";
    const chatKey = `github:private:${scopeKey}`;
    const wanted = text(messageId).trim();
    for (const bucket of fs.readdirSync(root).sort()) {
      const dir = path.join(root, bucket);
      if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".json")) continue;
        const record = readJson(path.join(dir, name), {});
        if (text(record.chatKey) !== chatKey) continue;
        if (wanted && text(record.messageId) !== wanted) continue;
        const session = usableSessionFile(record.sessionFile);
        if (session) return session;
      }
    }
    return "";
  }
  function bestSessionFor(scopeKey, fingerprint = "") {
    return chatStateSession(scopeKey) || recordsSession(scopeKey, fingerprint);
  }
  function syncScopeSession(scope) {
    if (!scope?.scopeKey) return false;
    const found = bestSessionFor(scope.scopeKey, scope.lastFingerprint);
    if (!found) return false;
    if (
      storedSessionPath(scope.sessionFile) === storedSessionPath(found) &&
      scope.sessionId
    )
      return false;
    scope.sessionFile = found;
    scope.sessionId = sessionIdFromFile(found);
    return true;
  }
  function hydrateActiveScopeSessions() {
    let changed = false;
    for (const scope of Object.values(state.scopes))
      if (scope?.active) changed = syncScopeSession(scope) || changed;
    if (changed) save();
    return changed;
  }
  function processingDir() {
    return path.join(ctx.dataDir, "chat", "inbox", "processing");
  }
  function processingItems() {
    const dir = processingDir();
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .map((n) => ({
        file: path.join(dir, n),
        item: readJson(path.join(dir, n), {}),
      }));
  }
  function scopeFromInbox(item) {
    const key = text(item?.chatKey);
    return key.startsWith("github:private:")
      ? key.slice("github:private:".length)
      : "";
  }
  function inboxMatches(scope, item) {
    return (
      scopeFromInbox(item) === scope?.scopeKey &&
      (!text(item?.messageId).trim() ||
        text(item.messageId).trim() === text(scope.lastFingerprint).trim())
    );
  }
  function hasProcessing(scope) {
    return processingItems().some(({ item }) => inboxMatches(scope, item));
  }
  function pruneSupersededInboxItems() {
    let changed = false;
    for (const { file, item } of processingItems()) {
      const scope = state.scopes[scopeFromInbox(item)];
      if (!scope?.active) continue;
      const itemFingerprint = text(item?.messageId).trim();
      const activeFingerprint = text(scope.lastFingerprint).trim();
      if (
        itemFingerprint &&
        activeFingerprint &&
        itemFingerprint !== activeFingerprint
      ) {
        fs.rmSync(file, { force: true });
        changed = true;
      }
    }
    return changed;
  }
  function pruneDeliveredInboxItems() {
    let changed = false;
    for (const { file, item } of processingItems()) {
      const scope = state.scopes[scopeFromInbox(item)];
      if (
        scope &&
        !scope.active &&
        scope.lastDeliveredAt &&
        inboxMatches(scope, item)
      ) {
        fs.rmSync(file, { force: true });
        changed = true;
      }
    }
    return changed;
  }
  function sessionMtime(scope) {
    return (
      fs.statSync(storedSessionPath(scope?.sessionFile), {
        throwIfNoEntry: false,
      })?.mtimeMs || 0
    );
  }
  function sessionFresh(scope) {
    const mtime = sessionMtime(scope);
    return Boolean(mtime && Date.now() - mtime < staleFreshMs);
  }
  function hasLiveProducer(scope) {
    if (!scope?.active) return false;
    if (hasProcessing(scope)) return true;
    const mtime = sessionMtime(scope);
    return Boolean(
      mtime &&
      mtime >= ms(scope.lastStartedAt) &&
      Date.now() - mtime < staleFreshMs,
    );
  }
  async function ensureOctokit() {
    if (octokit || !token) return octokit;
    const mod = await import("octokit");
    octokit = new mod.Octokit(octokitRuntimeOptions(token, requestTimeoutMs));
    return octokit;
  }
  function timeoutError(label) {
    return new Error(`github_issue_bridge_request_timeout:${label}`);
  }
  async function deadline(label, run, timeout = requestTimeoutMs) {
    const controller = new AbortController();
    let timer;
    const wait = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = timeoutError(label);
        try {
          controller.abort(error);
        } catch {}
        reject(error);
      }, timeout);
    });
    try {
      return await Promise.race([run(controller.signal), wait]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function rest(method, params, label) {
    return await deadline(label, (signal) =>
      method(withSignal(params, signal)),
    );
  }
  async function paginate(method, params, label) {
    return await deadline(
      label,
      (signal) => octokit.paginate(method, withSignal(params, signal)),
      Math.max(requestTimeoutMs, 60_000),
    );
  }
  async function request(route, params, label) {
    return await deadline(label, (signal) =>
      octokit.request(route, withSignal(params, signal)),
    );
  }
  function scopeUrl(scope) {
    return `https://github.com/${scope.repoFullName}/${scope.isPr ? "pull" : "issues"}/${scope.number}`;
  }
  function parseChatKey(chatKey) {
    const value = text(chatKey).trim();
    const [left, chatId] = value.split(":");
    const [platform, botId = ""] = left.split("/");
    return platform && chatId ? { platform, botId, chatId } : null;
  }
  function markdownNodeForFanout(body) {
    return { type: "markdown", attrs: { content: body } };
  }
  async function sendFanout(chatKey, body) {
    const parsed = parseChatKey(chatKey);
    if (!parsed || !app) return false;
    const bot = (Array.isArray(app.bots) ? app.bots : []).find(
      (item) =>
        text(item?.platform) === parsed.platform &&
        (!parsed.botId || text(item?.selfId) === parsed.botId),
    );
    if (!bot?.sendMessage) return false;
    await bot.sendMessage(parsed.chatId, [markdownNodeForFanout(body)]);
    return true;
  }
  function looksLikeMergeFinal(body) {
    const value = text(body);
    return (
      /(?:已合入|合入完成|merged|merge commit|PR\s*#?\d+\s*(?:已|was)?\s*(?:merge|merged)|gh pr merge)/i.test(
        value,
      ) && /(?:PR|pull request|merge|合入)/i.test(value)
    );
  }
  async function fanoutMergeFinal(body) {
    if (!looksLikeMergeFinal(body)) return;
    for (const chatKey of mergeFanoutChatKeys) {
      await deadline(
        `fanout:${chatKey}`,
        () => sendFanout(chatKey, body),
        requestTimeoutMs,
      ).catch((error) =>
        ctx.logger.warn?.(
          `github issue bridge merge final fanout failed for ${chatKey}: ${error?.message || error}`,
        ),
      );
    }
  }
  async function requestChatSessionShutdown(chatKey) {
    const appDir =
      process.env.RIN_APP_DIR || path.join(agentDir, "app", "current");
    const sdkUrl = pathToFileURL(
      path.join(appDir, "dist", "core", "rin-daemon", "client.js"),
    ).href;
    const { requestDaemonCommand } = await import(sdkUrl);
    return await requestDaemonCommand(
      { type: "chat_terminate_turn", payload: { chatKey } },
      { timeoutMs: requestTimeoutMs },
    );
  }
  async function shutdownClosedScope(scope) {
    if (!closeShutdownEnabled || !scope?.scopeKey || scope.sessionShutdownAt)
      return;
    const chatKey = `github:private:${scope.scopeKey}`;
    try {
      const result = await requestChatSessionShutdown(chatKey);
      scope.sessionShutdownAt = iso();
      scope.sessionShutdownResult = result;
    } catch (error) {
      scope.sessionShutdownError = text(error?.message || error);
      ctx.logger.warn?.(
        `github issue bridge session shutdown failed for ${scope.scopeKey}: ${error?.message || error}`,
      );
    }
  }

  async function addWorking(scope) {
    if (!workingLabel || !scope) return;
    await rest(
      octokit.rest.issues.addLabels,
      {
        owner: scope.repoOwner,
        repo: scope.repoName,
        issue_number: scope.number,
        labels: [workingLabel],
      },
      `add_working:${scope.scopeKey}`,
    ).catch((e) =>
      ctx.logger.warn?.(
        `github issue bridge add working label failed for ${scope.scopeKey}: ${e?.message || e}`,
      ),
    );
  }
  async function removeWorking(scope) {
    if (!workingLabel || !scope) return;
    await rest(
      octokit.rest.issues.removeLabel,
      {
        owner: scope.repoOwner,
        repo: scope.repoName,
        issue_number: scope.number,
        name: workingLabel,
      },
      `remove_working:${scope.scopeKey}`,
    ).catch(() => {});
  }
  function afterBaseline(at, baselineAt) {
    const baselineMs = ms(baselineAt);
    return !baselineMs || ms(at) >= baselineMs;
  }
  function orgManagedRepoForFullName(fullName) {
    const configured = repoMap.get(text(fullName));
    if (configured) return { repo: configured, baselineAt: "" };
    const parsed = parseRepo(fullName);
    const baselineAt = parsed
      ? text(issueOrgBaselines[parsed.owner]).trim()
      : "";
    return baselineAt ? { repo: parsed, baselineAt } : null;
  }
  function actorCanStart(login) {
    return canAccessGithubActor(ctx.dataDir, login);
  }
  function buildIssueEvent(repo, issue, comments = [], baselineAt = "") {
    const number = Number(issue?.number);
    if (!number || issue?.pull_request) return null;
    const issueCreatedAt = issue?.created_at;
    if (baselineAt && !afterBaseline(issueCreatedAt, baselineAt)) return null;
    const candidates = [];
    const issueAuthor = text(issue?.user?.login);
    const body = issueBody(issue);
    if (
      body &&
      issueAuthor !== botLogin &&
      actorCanStart(issueAuthor) &&
      afterBaseline(issueCreatedAt, baselineAt)
    ) {
      candidates.push({
        at: issueCreatedAt,
        actor: issueAuthor || "unknown",
        body,
        htmlUrl: issue.html_url,
        fingerprint: `issue_body:${number}:${issueCreatedAt}`,
        kind: "issue_body",
      });
    }
    for (const c of comments) {
      const body = text(c?.body).trim();
      const actor = text(c?.user?.login);
      if (!body || actor === botLogin || !actorCanStart(actor)) continue;
      const at = c.updated_at || c.created_at;
      if (!afterBaseline(at, baselineAt)) continue;
      candidates.push({
        at,
        actor: actor || "unknown",
        body,
        htmlUrl: c.html_url,
        fingerprint: `issue_comment:${c.id}:${at}`,
        kind: "issue_comment",
      });
    }
    const chosen = latest(candidates);
    return chosen
      ? {
          ...chosen,
          scopeKey: scopeKeyFor(repo, "issue", number),
          number,
          isPr: false,
          repoOwner: repo.owner,
          repoName: repo.repo,
          repoFullName: repo.fullName,
        }
      : null;
  }
  async function issueEvent(repo, number, baselineAt = "") {
    const issue = await rest(
      octokit.rest.issues.get,
      { owner: repo.owner, repo: repo.repo, issue_number: number },
      `issue:${repo.fullName}#${number}`,
    ).then((r) => r.data);
    const comments = await paginate(
      octokit.rest.issues.listComments,
      {
        owner: repo.owner,
        repo: repo.repo,
        issue_number: number,
        per_page: 100,
      },
      `comments:${repo.fullName}#${number}`,
    ).catch(() => []);
    return buildIssueEvent(repo, issue, comments, baselineAt);
  }
  async function latestEventForScope(scope) {
    const repo = repoMap.get(scope.repoFullName) || {
      owner: scope.repoOwner,
      repo: scope.repoName,
      fullName: scope.repoFullName,
    };
    return await issueEvent(repo, scope.number);
  }
  async function fetchNotifications() {
    const url = new URL("https://api.github.com/notifications");
    url.searchParams.set("all", "false");
    url.searchParams.set("participating", "false");
    url.searchParams.set("per_page", "50");
    return await deadline("notifications", async (signal) => {
      const r = await fetch(url, {
        signal,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "rin-github-issue-bridge",
          "x-github-api-version": "2022-11-28",
        },
      });
      if (!r.ok)
        throw new Error(`github_issue_bridge_notifications_http:${r.status}`);
      const data = await r.json();
      return (Array.isArray(data) ? data : []).sort(
        (a, b) => ms(a.updated_at) - ms(b.updated_at),
      );
    });
  }
  async function resolveNotification(n) {
    const managed = orgManagedRepoForFullName(n?.repository?.full_name);
    if (!managed || text(n?.subject?.type) !== "Issue") return null;
    const number = Number(text(n?.subject?.url).match(/\/issues\/(\d+)$/)?.[1]);
    return number
      ? await issueEvent(managed.repo, number, managed.baselineAt)
      : null;
  }
  async function markRead(threadId) {
    if (!threadId || text(threadId).startsWith("scan:")) return;
    await request(
      "PATCH /notifications/threads/{thread_id}",
      { thread_id: threadId },
      `mark_read:${threadId}`,
    ).catch(() => {});
  }
  async function scanRepo(repo, baselineAt = "") {
    const started = Date.now();
    const params = baselineAt
      ? {
          owner: repo.owner,
          repo: repo.repo,
          state: "all",
          since: baselineAt,
          sort: "updated",
          direction: "desc",
          per_page: 100,
        }
      : {
          owner: repo.owner,
          repo: repo.repo,
          state: "open",
          sort: "updated",
          direction: "desc",
          per_page: 100,
        };
    const issues = await rest(
      octokit.rest.issues.listForRepo,
      params,
      `scan:${repo.fullName}`,
    )
      .then((r) => (Array.isArray(r.data) ? r.data : []))
      .catch(() => []);
    const out = [];
    let inspected = 0;
    for (const issue of issues) {
      if (Date.now() - started >= scanBudgetMs) break;
      if (inspected >= scanIssueLimit) break;
      if (issue.pull_request) continue;
      const key = scopeKeyFor(repo, "issue", issue.number);
      const scope = state.scopes[key] || {};
      const knownMs = Math.max(
        ms(scope.lastEventAt),
        ms(scope.lastDeliveredAt),
        ms(scope.lastStartedAt),
      );
      if (!scope.active && knownMs && ms(issue.updated_at) <= knownMs) continue;
      inspected += 1;
      const comments = await paginate(
        octokit.rest.issues.listComments,
        {
          owner: repo.owner,
          repo: repo.repo,
          issue_number: issue.number,
          per_page: 100,
        },
        `scan_comments:${repo.fullName}#${issue.number}`,
      ).catch(() => []);
      const event = buildIssueEvent(repo, issue, comments, baselineAt);
      if (event)
        out.push({
          threadId: `scan:${repo.fullName}:issue:${event.number}:${event.fingerprint}`,
          event,
        });
    }
    return out;
  }
  async function orgIssueRepos({ advance = false } = {}) {
    const out = [];
    state.orgScanOffsets =
      state.orgScanOffsets && typeof state.orgScanOffsets === "object"
        ? state.orgScanOffsets
        : {};
    for (const [org, baselineAt] of Object.entries(issueOrgBaselines)) {
      const items = await paginate(
        octokit.rest.repos.listForOrg,
        { org, type: "all", per_page: 100 },
        `org_repos:${org}`,
      ).catch(() => []);
      const reposForOrg = items
        .map((item) => ({
          name: text(item?.name).trim(),
          archived: Boolean(item?.archived),
        }))
        .filter((item) => item.name && !item.archived)
        .sort((a, b) => a.name.localeCompare(b.name));
      if (!reposForOrg.length) continue;
      const start =
        Math.max(0, Number(state.orgScanOffsets[org] || 0)) %
        reposForOrg.length;
      const count = Math.min(orgScanRepoLimit, reposForOrg.length);
      for (let index = 0; index < count; index += 1) {
        const item = reposForOrg[(start + index) % reposForOrg.length];
        out.push({
          repo: {
            owner: org,
            repo: item.name,
            fullName: `${org}/${item.name}`,
          },
          baselineAt,
        });
      }
      if (advance)
        state.orgScanOffsets[org] = (start + count) % reposForOrg.length;
    }
    return out;
  }
  async function scannedEvents() {
    const started = Date.now();
    const seen = new Set();
    const out = [];
    const scanTargets = [
      ...repos.map((repo) => ({ repo, baselineAt: "" })),
      ...(await orgIssueRepos({ advance: true })),
    ];
    for (const { repo, baselineAt } of scanTargets) {
      if (Date.now() - started >= scanBudgetMs) break;
      for (const item of await scanRepo(repo, baselineAt)) {
        const key = `${item.event.scopeKey}:${item.event.fingerprint}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
      }
    }
    return out.sort((a, b) => ms(a.event.at) - ms(b.event.at));
  }
  async function scanClosedScopes() {
    const hadWatermark = Boolean(ms(state.closedScanWatermarkAt));
    const previousWatermarkMs = hadWatermark
      ? ms(state.closedScanWatermarkAt)
      : Date.now();
    if (!hadWatermark)
      state.closedScanWatermarkAt = new Date(previousWatermarkMs).toISOString();
    const started = Date.now();
    let nextWatermarkMs = previousWatermarkMs;
    for (const repo of repos) {
      if (Date.now() - started >= closedScanBudgetMs) break;
      const issues = await rest(
        octokit.rest.issues.listForRepo,
        {
          owner: repo.owner,
          repo: repo.repo,
          state: "closed",
          sort: "updated",
          direction: "desc",
          per_page: closedScanIssueLimit,
        },
        `scan_closed:${repo.fullName}`,
      )
        .then((r) => (Array.isArray(r.data) ? r.data : []))
        .catch(() => []);
      const closedIssues = issues
        .filter(
          (issue) =>
            !issue.pull_request &&
            (!issue.state || issue.state === "closed") &&
            ms(issue.closed_at),
        )
        .sort((a, b) => ms(a.closed_at) - ms(b.closed_at));
      for (const issue of closedIssues) {
        if (Date.now() - started >= closedScanBudgetMs) break;
        const key = scopeKeyFor(repo, "issue", issue.number);
        const scope = state.scopes[key];
        const closedAtMs = ms(issue.closed_at);
        const isNewClosure = closedAtMs > previousWatermarkMs;
        if (!isNewClosure && !(scope?.active && !hadWatermark)) continue;
        if (isNewClosure && closedAtMs > nextWatermarkMs)
          nextWatermarkMs = closedAtMs;
        if (!scope || scope.closedAt) continue;
        scope.closedAt = text(issue.closed_at || issue.updated_at || iso());
        scope.active = false;
        await removeWorking(scope);
        await shutdownClosedScope(scope);
        save();
      }
    }
    state.closedScanWatermarkAt = new Date(nextWatermarkMs).toISOString();
    save();
  }
  async function downloadImage(url, name) {
    const r = await deadline(
      `image:${url}`,
      (signal) =>
        fetch(url, {
          signal,
          headers: {
            authorization: `Bearer ${token}`,
            "user-agent": "rin-github-issue-bridge",
          },
        }),
      requestTimeoutMs,
    );
    if (!r.ok) throw new Error(`github_issue_bridge_image_http:${r.status}`);
    const mime = r.headers.get("content-type") || "";
    const bytes = Buffer.from(await r.arrayBuffer());
    mkdir(mediaDir);
    const file = path.join(
      mediaDir,
      `${cleanSegment(name)}${extForMime(mime) || path.extname(new URL(url).pathname) || ".img"}`,
    );
    fs.writeFileSync(file, bytes);
    return {
      type: "image",
      attrs: {
        src: new URL(`file://${file}`).href,
        url: new URL(`file://${file}`).href,
        name: path.basename(file),
      },
    };
  }
  async function buildElements(event) {
    const elements = [{ type: "markdown", attrs: { content: event.body } }];
    const urls = [];
    for (const m of event.body.matchAll(
      /!\[([^\]]*)\]\((https:\/\/github\.com\/user-attachments\/[^)\s]+)\)/g,
    ))
      urls.push({ name: m[1] || "image", url: m[2] });
    for (const m of event.body.matchAll(
      /<img\s+[^>]*src=["'](https:\/\/github\.com\/user-attachments\/[^"']+)["'][^>]*>/gi,
    ))
      urls.push({ name: "image", url: m[1] });
    for (const item of urls) {
      try {
        elements.push(await downloadImage(item.url, item.name));
      } catch (e) {
        ctx.logger.warn?.(
          `github issue bridge image download failed: ${e?.message || e}`,
        );
      }
    }
    return elements;
  }
  function messageForEvent(event) {
    return {
      platform: "github",
      selfId: botId,
      channelId: `private:${event.scopeKey}`,
      userId: event.actor,
      messageId: event.fingerprint,
      isDirect: true,
      content: event.body,
      stripped: { content: event.body },
      elements: [],
      channelName: `${event.repoFullName} ${event.isPr ? "PR" : "Issue"} #${event.number}`,
      runtimeMetadata: {
        "github repo": event.repoFullName,
        "github target": `${event.isPr ? "pr" : "issue"} #${event.number}`,
        "github url": event.htmlUrl,
        "github event": event.kind,
      },
    };
  }
  async function emitEvent(event) {
    if (!app) return false;
    const message = messageForEvent(event);
    message.elements = await buildElements(event);
    await app.emit("message", message);
    return true;
  }
  function activeCount() {
    return Object.values(state.scopes).filter((s) => s?.active).length;
  }
  function deliveredSame(scope, event) {
    return Boolean(
      scope?.lastDeliveredAt &&
      text(scope.lastDeliveredFingerprint || scope.lastFingerprint) ===
        event.fingerprint,
    );
  }
  async function processEvent(threadId, event, markThreadRead = false) {
    if (!event) return "skipped";
    if (!actorCanStart(event.actor)) {
      if (threadId)
        state.processed[threadId] ||= `skipped_unauthorized:${iso()}`;
      save();
      if (markThreadRead) await markRead(threadId);
      return `skipped_unauthorized:${event.scopeKey}`;
    }
    const existing = state.scopes[event.scopeKey] || {};
    if (existing.active && existing.lastFingerprint === event.fingerprint) {
      if (markThreadRead) await markRead(threadId);
      return `duplicate_active:${event.scopeKey}`;
    }
    if (existing.active && existing.lastFingerprint !== event.fingerprint) {
      state.processed[text(existing.lastStartedThreadId) || threadId] =
        `superseded:${iso()}`;
      existing.active = false;
      await removeWorking(existing);
    }
    if (deliveredSame(existing, event)) {
      if (markThreadRead) await markRead(threadId);
      return `duplicate_delivered:${event.scopeKey}`;
    }
    if (maxConcurrentScopes > 0 && activeCount() >= maxConcurrentScopes)
      return `queued_capacity:${event.scopeKey}`;
    const scope = {
      ...existing,
      ...event,
      active: true,
      lastStartedAt: iso(),
      lastStartedThreadId: threadId,
      lastFingerprint: event.fingerprint,
      lastEventAt: event.at,
      lastDeliveredAt: "",
      lastDeliveredFingerprint: "",
      lastFinalCommentUrl: "",
      lastFinalText: "",
    };
    state.scopes[event.scopeKey] = scope;
    syncScopeSession(scope);
    state.processed[threadId] = `claimed:${iso()}`;
    save();
    await addWorking(scope);
    const ok = await emitEvent(event);
    if (markThreadRead) await markRead(threadId);
    if (!ok) {
      scope.active = false;
      state.processed[threadId] = `not_ready:${iso()}`;
      save();
      await removeWorking(scope);
      return `not_ready:${event.scopeKey}`;
    }
    save();
    return `queued:${event.scopeKey}`;
  }
  function readSessionFinal(file, afterMs = 0) {
    const full = storedSessionPath(file);
    if (!full || !fs.existsSync(full)) return "";
    let finalText = "";
    for (const line of fs.readFileSync(full, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      const msg = item?.message;
      if (item?.type !== "message" || msg?.role !== "assistant") continue;
      const t = ms(item?.timestamp);
      if (afterMs && (!t || t < afterMs)) continue;
      const parts = Array.isArray(msg.content) ? msg.content : [];
      if (parts.some((p) => p?.type === "toolCall")) continue;
      const body = parts
        .filter((p) => p?.type === "text")
        .map((p) => text(p.text).trim())
        .filter(Boolean)
        .join("\n\n")
        .trim();
      if (looksUsableFinal(body)) finalText = body;
    }
    return finalText;
  }
  async function existingFinal(scope, body) {
    const comments = await paginate(
      octokit.rest.issues.listComments,
      {
        owner: scope.repoOwner,
        repo: scope.repoName,
        issue_number: scope.number,
        per_page: 100,
      },
      `existing:${scope.scopeKey}`,
    ).catch(() => []);
    for (const c of comments)
      if (text(c.user?.login) === botLogin && text(c.body).trim() === body)
        return text(c.html_url);
    const linked = body.match(
      /https:\/\/github\.com\/[^\s)]+#issuecomment-(\d+)/,
    );
    if (linked) {
      const parts = commentUrlParts(linked[0]);
      if (parts) {
        const c = await rest(
          octokit.rest.issues.getComment,
          { owner: parts.owner, repo: parts.repo, comment_id: parts.commentId },
          `linked:${parts.commentId}`,
        )
          .then((r) => r.data)
          .catch(() => null);
        if (c?.html_url) return text(c.html_url);
      }
    }
    return "";
  }
  async function sendMessage(chatId, content, options = {}) {
    const scope = state.scopes[text(chatId).replace(/^private:/, "")];
    if (!scope) throw new Error(`github_issue_bridge_unknown_scope:${chatId}`);
    const body = contentText(content).trim();
    if (!body) throw new Error("github_issue_bridge_empty_message");
    const deliveryKind = text(options?.deliveryKind).trim() || "final";
    if (deliveryKind !== "final") return [scopeUrl(scope)];
    if (
      scope.lastDeliveredAt &&
      scope.lastDeliveredFingerprint === scope.lastFingerprint
    )
      return [scope.lastFinalCommentUrl || scopeUrl(scope)];
    if (looksInterim(body) || looksPassiveNotice(body))
      return [scopeUrl(scope)];
    if (!(await ensureOctokit()))
      throw new Error("github_issue_bridge_token_missing");
    let url = await existingFinal(scope, body);
    if (!url) {
      try {
        url = await rest(
          octokit.rest.issues.createComment,
          {
            owner: scope.repoOwner,
            repo: scope.repoName,
            issue_number: scope.number,
            body,
          },
          `create_comment:${scope.scopeKey}`,
        ).then((r) => text(r.data.html_url));
      } catch (e) {
        if (
          text(e?.message || e).includes("github_issue_bridge_request_timeout")
        )
          throw new Error(`rin_timeout:${e?.message || e}`);
        throw e;
      }
    }
    Object.assign(scope, {
      active: false,
      lastDeliveredAt: iso(),
      lastDeliveredFingerprint: scope.lastFingerprint,
      lastFinalText: body,
      lastFinalCommentUrl: url,
      incompleteFinalRetries: 0,
      lastIncompleteFinalAt: "",
      runtimeFailureRetries: 0,
      lastRuntimeFailureAt: "",
    });
    state.processed[text(scope.lastStartedThreadId)] = `delivered:${iso()}`;
    save();
    pruneDeliveredInboxItems();
    await fanoutMergeFinal(body);
    await removeWorking(scope);
    return [url || scopeUrl(scope)];
  }
  async function recoverSessionFinalActiveScopes() {
    for (const scope of Object.values(state.scopes)) {
      if (!scope?.active) continue;
      syncScopeSession(scope);
      const final = readSessionFinal(
        scope.sessionFile,
        ms(scope.lastStartedAt),
      );
      if (final)
        await sendMessage(`private:${scope.scopeKey}`, final).catch((e) =>
          ctx.logger.warn?.(
            `github issue bridge session final recovery failed for ${scope.scopeKey}: ${e?.message || e}`,
          ),
        );
    }
  }
  async function recoverDeliveredActiveScopes() {
    for (const scope of Object.values(state.scopes)) {
      if (!scope?.active || !ms(scope.lastStartedAt)) continue;
      const comments = await paginate(
        octokit.rest.issues.listComments,
        {
          owner: scope.repoOwner,
          repo: scope.repoName,
          issue_number: scope.number,
          per_page: 100,
        },
        `recover:${scope.scopeKey}`,
      ).catch(() => []);
      const c = comments
        .filter(
          (x) =>
            text(x.user?.login) === botLogin &&
            ms(x.created_at) >= ms(scope.lastStartedAt) &&
            looksUsableFinal(x.body),
        )
        .sort((a, b) => ms(b.created_at) - ms(a.created_at))[0];
      if (!c) continue;
      Object.assign(scope, {
        active: false,
        lastDeliveredAt: iso(),
        lastDeliveredFingerprint: scope.lastFingerprint,
        lastFinalText: text(c.body).trim(),
        lastFinalCommentUrl: text(c.html_url),
      });
      state.processed[text(scope.lastStartedThreadId)] = `delivered:${iso()}`;
      save();
      await removeWorking(scope);
    }
  }
  function repairNonFinalDeliveredScopes() {
    let changed = false;
    for (const scope of Object.values(state.scopes)) {
      if (!scope?.lastDeliveredAt || looksUsableFinal(scope.lastFinalText))
        continue;
      scope.active = false;
      scope.lastDeliveredAt = "";
      scope.lastDeliveredFingerprint = "";
      scope.lastFinalText = "";
      scope.lastFinalCommentUrl = "";
      changed = true;
    }
    if (changed) save();
    return changed;
  }
  async function repairPreEventRecoveredDeliveries() {
    let count = 0;
    for (const scope of Object.values(state.scopes)) {
      if (
        !scope?.lastDeliveredAt ||
        !scope.lastFinalCommentUrl ||
        !scope.lastEventAt
      )
        continue;
      const parts = commentUrlParts(scope.lastFinalCommentUrl);
      if (!parts) continue;
      const c = await rest(
        octokit.rest.issues.getComment,
        { owner: parts.owner, repo: parts.repo, comment_id: parts.commentId },
        `pre_event:${parts.commentId}`,
      )
        .then((r) => r.data)
        .catch(() => null);
      if (
        !c ||
        ms(c.created_at) >= ms(scope.lastStartedAt || scope.lastEventAt)
      )
        continue;
      scope.active = false;
      scope.lastDeliveredAt = "";
      scope.lastDeliveredFingerprint = "";
      scope.lastFinalText = "";
      scope.lastFinalCommentUrl = "";
      state.processed[text(scope.lastStartedThreadId)] =
        `stale_delivery_repaired:${iso()}`;
      save();
      await processEvent(
        `repair:${scope.scopeKey}:${scope.lastFingerprint}`,
        {
          ...scope,
          fingerprint: scope.lastFingerprint,
          at: scope.lastEventAt,
          body: scope.body || "继续",
          htmlUrl: scope.htmlUrl || scopeUrl(scope),
        },
        false,
      );
      count += 1;
    }
    return count;
  }
  async function retryStaleActiveScopes() {
    hydrateActiveScopeSessions();
    for (const scope of Object.values(state.scopes)) {
      if (!scope?.active) continue;
      if (hasLiveProducer(scope)) continue;
      if (Date.now() - ms(scope.lastStartedAt) < orphanActiveMs) continue;
      const oldThread = text(scope.lastStartedThreadId);
      const latest = await latestEventForScope(scope).catch(() => null);
      scope.active = false;
      await removeWorking(scope);
      if (!latest || latest.fingerprint === scope.lastFingerprint) {
        state.processed[oldThread] = `orphan_cleared:${iso()}`;
        save();
        continue;
      }
      state.processed[oldThread] = `retry_superseded:${iso()}`;
      save();
      await processEvent(
        `retry:${scope.scopeKey}:${latest.fingerprint}`,
        latest,
        false,
      );
    }
  }
  async function reconcileWorkingLabels() {
    if (!workingLabel || !(await ensureOctokit())) return;
    for (const scope of Object.values(state.scopes))
      if (scope?.active) await addWorking(scope);
    const scanTargets = [
      ...repos.map((repo) => ({ repo, baselineAt: "" })),
      ...(await orgIssueRepos({ advance: false })),
    ];
    for (const { repo } of scanTargets) {
      const issues = await rest(
        octokit.rest.issues.listForRepo,
        {
          owner: repo.owner,
          repo: repo.repo,
          state: "all",
          labels: workingLabel,
          per_page: 100,
        },
        `working_labels:${repo.fullName}`,
      )
        .then((r) => (Array.isArray(r.data) ? r.data : []))
        .catch(() => []);
      for (const issue of issues) {
        const key = scopeKeyFor(
          repo,
          issue.pull_request ? "pr" : "issue",
          issue.number,
        );
        if (!state.scopes[key]?.active)
          await removeWorking({
            repoOwner: repo.owner,
            repoName: repo.repo,
            number: issue.number,
            scopeKey: key,
          });
      }
    }
  }
  function record(field) {
    const at = iso();
    state[field] = at;
    state.lastPollHeartbeatAt = at;
    save();
  }
  async function localMaintenance() {
    pruneSupersededInboxItems();
    pruneDeliveredInboxItems();
    hydrateActiveScopeSessions();
    repairNonFinalDeliveredScopes();
  }
  async function tick() {
    if (!(await ensureOctokit()) || stopped) return;
    const started = iso();
    state.lastPollStartedAt = started;
    state.lastPollHeartbeatAt = started;
    state.lastPolledAt = started;
    save();
    await localMaintenance();
    await recoverSessionFinalActiveScopes();
    await recoverDeliveredActiveScopes();
    await retryStaleActiveScopes();
    await repairPreEventRecoveredDeliveries();
    await reconcileWorkingLabels();
    const notifications = await fetchNotifications().catch(() => []);
    for (const n of notifications) {
      const threadId = text(n.id);
      if (!threadId) continue;
      const event = await resolveNotification(n).catch(() => null);
      if (!event) {
        state.processed[threadId] ||= `skipped:${iso()}`;
        await markRead(threadId);
        continue;
      }
      const result = await processEvent(threadId, event, true);
      if (result.startsWith("queued_capacity:")) break;
    }
    for (const item of await scannedEvents().catch(() => [])) {
      if (state.processed[item.threadId]) continue;
      const result = await processEvent(item.threadId, item.event, false);
      if (result.startsWith("queued_capacity:")) break;
    }
    await scanClosedScopes();
    await localMaintenance();
    await reconcileWorkingLabels();
    record("lastPollFinishedAt");
  }
  function startTickIfDue() {
    if (ticking) {
      if (!tickWarned && Date.now() - tickStartedAt > tickWarnMs) {
        tickWarned = true;
        ctx.logger.warn?.(
          `github issue bridge tick still running after ${Date.now() - tickStartedAt}ms; no overlapping tick will start`,
        );
      }
      return;
    }
    ticking = true;
    tickStartedAt = Date.now();
    tickWarned = false;
    const timer = setTimeout(() => {
      tickWarned = true;
      ctx.logger.warn?.(
        `github issue bridge tick still running after ${Date.now() - tickStartedAt}ms; no overlapping tick will start`,
      );
    }, tickWarnMs);
    void tick()
      .catch((e) =>
        ctx.logger.warn?.(
          `github issue bridge tick failed: ${e?.message || e}`,
        ),
      )
      .finally(() => {
        clearTimeout(timer);
        ticking = false;
        tickStartedAt = 0;
        tickWarned = false;
      });
  }
  async function loop() {
    while (!stopped && !ctx.signal.aborted) {
      startTickIfDue();
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  return {
    register(nextApp) {
      app = nextApp;
    },
    start() {
      if (!repos.length) {
        ctx.logger.warn?.(
          "github issue bridge has no repositories configured; set githubIssueBridge.repositories",
        );
        return;
      }
      if (!token) {
        ctx.logger.warn?.(
          "github issue bridge token missing; set githubIssueBridge.token or GITHUB_TOKEN",
        );
        return;
      }
      void localMaintenance();
      ctx.runAsync("github-issue-bridge", loop);
    },
    async stop() {
      stopped = true;
      save();
    },
    adapterProvider({ app: nextApp }) {
      app = nextApp;
      return {
        adapter: { start() {}, stop() {} },
        bot: {
          platform: "github",
          selfId: botId,
          status: 1,
          workingIndicators: [
            {
              type: "marker",
              start: async ({ chatId }) => {
                if (!(await ensureOctokit())) return false;
                const scope =
                  state.scopes[text(chatId).replace(/^private:/, "")];
                if (scope) await addWorking(scope);
                return Boolean(scope);
              },
              end: async ({ chatId }) => {
                if (!(await ensureOctokit())) return false;
                const scope =
                  state.scopes[text(chatId).replace(/^private:/, "")];
                if (scope && !scope.active) await removeWorking(scope);
                return Boolean(scope);
              },
            },
          ],
          sendMessage,
        },
      };
    },
    _test: {
      buildMessageText: (event) => event?.body || "",
      emitEvent,
      processEvent,
      recoverDeliveredActiveScopes,
      recoverSessionFinalActiveScopes,
      hydrateActiveScopeSessions,
      reconcileWorkingLabels,
      repairNonFinalDeliveredScopes,
      repairPreEventRecoveredDeliveries,
      pruneSupersededInboxItems,
      retryStaleActiveScopes,
      sendMessage,
      scanClosedScopes,
      tick,
      octokitRuntimeOptions,
      state: () => state,
    },
  };
}
