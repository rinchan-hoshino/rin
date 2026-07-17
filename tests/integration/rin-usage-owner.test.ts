import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

await import("../support/register-usage-owner-fixture.ts");
const usage = await import(
  pathToFileURL(path.resolve("dist/core/rin/usage.js")).href
);
const ownerGlobal = globalThis as any;
const events = ownerGlobal.__rinUsageOwnerEvents as any[];
const scenario = ownerGlobal.__rinUsageOwnerScenario as Record<string, any>;

function reset() {
  events.length = 0;
  for (const key of Object.keys(scenario)) delete scenario[key];
  scenario.context = { isTargetUser: true, installDir: "/owner/install" };
  scenario.runtime = {
    AuthStorage: {
      create() {
        return {
          async getApiKey(provider: string) {
            if (provider === "refresh-error") throw new Error("refresh failed");
            if (provider.startsWith("google")) {
              return JSON.stringify({
                token: "google-refreshed",
                projectId: "project-refreshed",
              });
            }
            return `${provider}-refreshed`;
          },
          get(provider: string) {
            return { email: `${provider}@owner.invalid` };
          },
        };
      },
    },
  };
  scenario.dimensions = ["session", "provider_model"];
  scenario.overview = {
    total_events: 3,
    token_events: 2,
    session_count: 1,
    model_count: 1,
    total_tokens: 100,
    input_tokens: 40,
    output_tokens: 20,
    cache_read_tokens: 30,
    cache_write_tokens: 10,
    cost_total: 1.25,
    first_timestamp: "2026-07-01T00:00:00.000Z",
    last_timestamp: "2026-07-02T00:00:00.000Z",
  };
  scenario.aggregateRows = [
    {
      session: "owner",
      provider_model: "owner/model",
      capability: "read",
      hour: "2026-07-18T00",
      rows: 2,
      token_events: 2,
      input_tokens: 40,
      output_tokens: 20,
      cache_read_tokens: 30,
      cache_write_tokens: 10,
      total_tokens: 100,
      cost_total: 1.25,
    },
  ];
  scenario.eventRows = [
    {
      timestamp: "2026-07-18T01:02:03.000Z",
      session_id: "session-1",
      event_type: "message_end",
      provider: "owner",
      model: "model",
      capability_key: "read",
      tool_name: "read",
      message_role: "assistant",
      total_tokens: 10,
      cost_total: 0.5,
      stop_reason: "stop",
    },
    { event_type: "tool_end", total_tokens: 0 },
  ];
}

async function withAuth(
  value: unknown,
  run: (agentDir: string) => Promise<void>,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-usage-owner-"));
  try {
    await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify(value));
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  } as Response;
}

test("usage parser owns wrapper extraction, time normalization, defaults, and failures", () => {
  reset();
  const before = Date.now();
  const parsed = usage.parseUsageArgs([
    "--user=owner",
    "usage",
    "--from",
    "2h",
    "--to",
    "2026-07-18",
    "--group-by",
    " session, capability ,,",
    "--filter",
    "source=chat",
    "--filter",
    "model=owner=model",
    "--limit",
    "4.6",
    "--order-by",
    "cost_total",
    "--direction",
    "ASC",
    "--events",
    "--include-zero",
    "--dimensions",
    "--json",
  ]);
  assert.equal(
    Math.abs(Date.parse(parsed.from!) - (before - 2 * 3_600_000)) < 20,
    true,
  );
  assert.equal(parsed.to, "2026-07-18T23:59:59.999Z");
  assert.deepEqual(parsed.groupBy, ["session", "capability"]);
  assert.deepEqual(parsed.filters, [
    { key: "source", value: "chat" },
    { key: "model", value: "owner=model" },
  ]);
  assert.equal(parsed.limit, 5);
  assert.equal(parsed.orderBy, "cost_total");
  assert.equal(parsed.direction, "asc");
  assert.equal(
    parsed.events && parsed.includeZero && parsed.dimensions && parsed.json,
    true,
  );

  assert.deepEqual(usage.parseUsageArgs(["usage", "-h"]), {
    ...usage.createDefaultUsageOptions(),
    help: true,
  });
  assert.equal(
    usage.parseUsageArgs([
      "usage",
      "--from",
      "2026-07-18T01:02:03Z",
      "--limit",
      "bad",
      "--direction",
      "sideways",
    ]).limit,
    20,
  );
  assert.equal(
    usage.parseUsageArgs(["usage", "--from", "1m"]).from?.endsWith("Z"),
    true,
  );
  assert.equal(
    usage.parseUsageArgs(["usage", "--from", "1d"]).from?.endsWith("Z"),
    true,
  );
  assert.equal(
    usage.parseUsageArgs(["usage", "--from", "1w"]).from?.endsWith("Z"),
    true,
  );
  assert.equal(
    usage.parseUsageArgs(["usage", "--from", "2026-07-18"]).from,
    "2026-07-18T00:00:00.000Z",
  );
  assert.equal(usage.parseUsageArgs(["usage", "--from", ""]).from, undefined);
  assert.throws(
    () => usage.parseUsageArgs(["usage", "--from", "later"]),
    /invalid_time:later/,
  );
  assert.throws(
    () => usage.parseUsageArgs(["usage", "--filter", "owner"]),
    /invalid_filter:owner/,
  );
  assert.throws(
    () => usage.parseUsageArgs(["usage", "--filter", "=owner"]),
    /invalid_filter/,
  );
  assert.throws(
    () => usage.parseUsageArgs(["usage", "--bad"]),
    /unknown_usage_arg:--bad/,
  );
});

test("usage subscription parsers normalize provider windows and credits", () => {
  reset();
  const token = [
    Buffer.from("{}").toString("base64url"),
    Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "jwt-account",
          chatgpt_plan_type: "plus",
        },
        "https://api.openai.com/profile": { email: "jwt@owner.invalid" },
      }),
    ).toString("base64url"),
    "signature",
  ].join(".");
  const parsed = usage.parseCodexSubscriptionUsage(
    {
      accountId: "api-account",
      planType: "pro",
      rate_limits: {
        primary: {
          used_percent: 25,
          reset_time_ms: 2_000_000_000_000,
          limit_window_seconds: 3600,
        },
        secondary: {
          remaining_percent: 150,
          reset_at: 2_000_000_000,
          limit_window_seconds: 604800,
        },
      },
      credits: { balance: 12 },
    },
    { access: token },
  );
  assert.equal(parsed.accountName, "jwt@owner.invalid");
  assert.equal(parsed.accountId, "api-account");
  assert.equal(parsed.plan, "pro");
  assert.deepEqual(
    parsed.windows.map((entry: any) => [entry.name, entry.percentLeft]),
    [
      ["five_hour", 75],
      ["weekly", 100],
    ],
  );
  assert.equal(parsed.credits, "12");

  const nested = usage.parseCodexSubscriptionUsage({
    rate_limit: {
      five_hour: { primary_window: { percent_left: -3 } },
      weekly_limit: {},
    },
  });
  assert.equal(nested.windows[0].percentLeft, 0);
  assert.equal(nested.windows[0].resetAt, undefined);

  for (const rateLimit of [
    { five_hour_limit: { percent_left: 1 }, weekly: { percent_left: 2 } },
    {
      primary_window: { percent_left: 3 },
      secondary_window: { percent_left: 4 },
    },
    { primary: { percent_left: 5 }, secondary: { percent_left: 6 } },
  ]) {
    assert.equal(
      usage.parseCodexSubscriptionUsage({ rate_limit: rateLimit }).windows
        .length,
      2,
    );
  }

  const anthropic = usage.parseAnthropicSubscriptionUsage({
    five_hour: { utilization: 12.5, resets_at: "2026-07-18T02:00:00Z" },
    seven_day: { remaining_percent: 25, reset_at: "bad" },
    extra_usage: { used_credits: 123, monthly_limit: 456 },
  });
  assert.deepEqual(
    anthropic.windows.map((entry: any) => entry.percentLeft),
    [87.5, 25],
  );
  assert.equal(anthropic.windows[1].resetAt, undefined);
  assert.equal(anthropic.credits, "1.23/4.56");
  assert.deepEqual(usage.parseAnthropicSubscriptionUsage({}), {
    windows: [],
    credits: undefined,
  });
});

test("usage provider loading refreshes OAuth credentials and isolates HTTP failures", async () => {
  reset();
  const originalFetch = globalThis.fetch;
  const token = [
    Buffer.from("{}").toString("base64url"),
    Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "account" },
      }),
    ).toString("base64url"),
    "sig",
  ].join(".");
  const auth = {
    "openai-codex": { type: "oauth", access: token, accountId: "account" },
    anthropic: { type: "oauth", access: "anthropic" },
    "github-copilot": { type: "oauth", refresh: "github" },
    "google-gemini-cli": { type: "oauth", access: "google" },
    "google-antigravity": {
      type: "oauth",
      access: "google",
      email: "known@owner.invalid",
    },
    "api-owner": { type: "api_key", access: "key" },
    "refresh-error": { type: "oauth", access: "old" },
    broken: null,
  };
  try {
    globalThis.fetch = (async (url: string) => {
      if (url.includes("wham"))
        return response(200, {
          rate_limit: { primary_window: { percent_left: 55 } },
        });
      if (url.includes("anthropic")) return response(503, { error: true });
      if (url.includes("github"))
        return response(200, { login: "octo", id: 42 });
      if (url.includes("googleapis")) return response(200, "not-json");
      throw new Error(`unexpected:${url}`);
    }) as typeof fetch;
    await withAuth(auth, async (agentDir) => {
      const statuses = await usage.loadProviderQuotaStatuses(agentDir);
      assert.deepEqual(
        statuses.map((entry: any) => entry.provider),
        [
          "anthropic",
          "api-owner",
          "github-copilot",
          "google-antigravity",
          "google-gemini-cli",
          "openai-codex",
          "refresh-error",
        ],
      );
      assert.equal(
        statuses.find((entry: any) => entry.provider === "openai-codex")
          .windows[0].percentLeft,
        55,
      );
      assert.equal(
        statuses.find((entry: any) => entry.provider === "anthropic").error,
        "quota HTTP 503",
      );
      assert.equal(
        statuses.find((entry: any) => entry.provider === "github-copilot")
          .accountName,
        "octo",
      );
      assert.equal(
        statuses.find((entry: any) => entry.provider === "google-antigravity")
          .accountName,
        "google-antigravity@owner.invalid",
      );
      assert.equal(
        statuses.find((entry: any) => entry.provider === "google-gemini-cli")
          .error,
        "quota unavailable",
      );
      assert.equal(
        statuses.find((entry: any) => entry.provider === "api-owner").authType,
        "api_key",
      );
      assert.equal(
        statuses.find((entry: any) => entry.provider === "refresh-error").error,
        "quota unavailable",
      );

      const codex = await usage.loadCodexSubscriptionStatus(agentDir);
      assert.equal(codex.configured, true);
      assert.equal(codex.windows[0].percentLeft, 55);
    });

    await withAuth(
      { "openai-codex": { type: "api_key" } },
      async (agentDir) => {
        assert.deepEqual(await usage.loadCodexSubscriptionStatus(agentDir), {
          configured: false,
          windows: [],
        });
      },
    );
    await withAuth("invalid", async (agentDir) => {
      assert.deepEqual(await usage.loadProviderQuotaStatuses(agentDir), []);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("usage provider loading reports missing credentials, malformed auth, and network errors", async () => {
  reset();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    scenario.runtimeError = new Error("refresh unavailable");
    await withAuth(
      {
        "openai-codex": { type: "oauth", access: "bad.jwt" },
        anthropic: { type: "oauth" },
        "github-copilot": { type: "oauth" },
        "google-gemini-cli": { type: "oauth", access: "token" },
      },
      async (agentDir) => {
        const statuses = await usage.loadProviderQuotaStatuses(agentDir);
        assert.equal(
          statuses.find((entry: any) => entry.provider === "openai-codex")
            .error,
          "missing token",
        );
        assert.equal(
          statuses.find((entry: any) => entry.provider === "anthropic").error,
          "missing token",
        );
        assert.equal(
          statuses.find((entry: any) => entry.provider === "github-copilot")
            .error,
          "quota unavailable",
        );
        assert.equal(
          statuses.find((entry: any) => entry.provider === "google-gemini-cli")
            .error,
          "quota unavailable",
        );
      },
    );
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "rin-usage-owner-bad-"),
    );
    try {
      await fs.writeFile(path.join(dir, "auth.json"), "{");
      assert.deepEqual(await usage.loadProviderQuotaStatuses(dir), []);
      assert.deepEqual(
        await usage.loadProviderQuotaStatuses(path.join(dir, "missing")),
        [],
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("usage report renders frontend, backend, event, aggregate, dimensions, and help contracts", () => {
  reset();
  const quotas = [
    {
      provider: "openai-codex",
      label: "ChatGPT Codex",
      configured: true,
      accountName: "owner",
      plan: "plus",
      windows: [
        { name: "five_hour", percentLeft: 75, resetAt: "2026-07-18T02:00:00Z" },
        { name: "seven_day", percentLeft: undefined },
        { name: "owner_window", percentLeft: 25 },
      ],
      credits: "10",
    },
    {
      provider: "empty",
      label: "Empty",
      configured: true,
      windows: [],
      error: "offline",
    },
  ];
  const frontend = usage.renderUsageReport(
    "/owner",
    usage.createDefaultUsageOptions(),
    quotas,
  );
  assert.match(frontend, /Accounts & quota/);
  assert.match(frontend, /OWNER TREND/);
  assert.match(frontend, /5-hour/);
  assert.match(frontend, /7-day/);
  assert.match(frontend, /owner_window/);
  assert.match(frontend, /Quota temporarily unavailable \(offline\)/);

  assert.match(
    usage.renderUsageReport("/owner", {
      ...usage.createDefaultUsageOptions(),
      dimensions: true,
    }),
    /supported dimensions/,
  );
  const eventsReport = usage.renderUsageReport("/owner", {
    ...usage.createDefaultUsageOptions(),
    events: true,
    from: "2026-07-01T00:00:00Z",
  });
  assert.match(eventsReport, /provider_model/);
  const aggregateReport = usage.renderUsageReport("/owner", {
    ...usage.createDefaultUsageOptions(),
    groupBy: ["session"],
    includeZero: true,
  });
  assert.match(aggregateReport, /aggregate/);
  const overviewReport = usage.renderUsageReport(
    "/owner",
    {
      ...usage.createDefaultUsageOptions(),
      from: "2026-07-01T00:00:00Z",
    },
    quotas,
  );
  assert.match(overviewReport, /overview/);
  assert.match(overviewReport, /recent token events/);

  for (const options of [
    { ...usage.createDefaultUsageOptions(), json: true },
    { ...usage.createDefaultUsageOptions(), json: true, dimensions: true },
    { ...usage.createDefaultUsageOptions(), json: true, events: true },
    { ...usage.createDefaultUsageOptions(), json: true, groupBy: ["session"] },
  ]) {
    const parsed = JSON.parse(
      usage.renderUsageReport("/owner", options, quotas),
    );
    assert.equal(parsed.schemaVersion, 1);
  }

  const writes: string[] = [];
  const originalLog = console.log;
  console.log = (value?: any) => writes.push(String(value ?? ""));
  try {
    assert.equal(
      usage.renderUsageReport("/owner", {
        ...usage.createDefaultUsageOptions(),
        help: true,
      }),
      "",
    );
  } finally {
    console.log = originalLog;
  }
  assert.match(writes.join("\n"), /rin usage \[options\]/);
  assert.match(
    usage.renderUsageReport("/owner", usage.createDefaultUsageOptions()),
    /Not checked/,
  );
  assert.match(
    usage.renderUsageReport("/owner", usage.createDefaultUsageOptions(), []),
    /No configured providers/,
  );
});

test("usage chat and CLI entrypoints preserve image, validation, forwarding, and help behavior", async () => {
  reset();
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const logs: string[] = [];
  try {
    globalThis.fetch = (async () =>
      response(200, {
        rate_limit: { primary: { percent_left: 60 } },
      })) as typeof fetch;
    console.log = (value?: any) => logs.push(String(value ?? ""));
    await withAuth(
      {
        "openai-codex": { type: "oauth", access: "a.b.c", accountId: "owner" },
      },
      async (agentDir) => {
        const compact = await usage.renderCompactUsageReportForChat(agentDir);
        assert.match(compact, /Accounts & quota/);
        const report = await usage.renderUsageReportForChat(agentDir);
        assert.deepEqual(report, {
          text: "",
          parts: [
            {
              type: "image",
              path: "/tmp/owner-usage.png",
              mimeType: "image/png",
            },
          ],
        });
        process.env.RIN_DIR = agentDir;
        await usage.runUsageInternal(["usage", "--json"]);
        assert.equal(JSON.parse(logs.at(-1)!).schemaVersion, 1);
      },
    );

    await usage.runUsageInternal(["usage", "--help"]);
    await usage.runUsage({ owner: true }, ["usage", "--help"]);
    await usage.runUsage({ owner: true }, ["usage", "--dimensions"]);
    assert.match(logs.at(-1)!, /supported dimensions/);

    scenario.context = { isTargetUser: false, installDir: "/owner/install" };
    scenario.forwarded = "";
    await usage.runUsage({ owner: false }, ["usage", "--events"]);
    assert.deepEqual(events.find(([name]) => name === "forward")?.slice(2), [
      "__usage_internal",
      ["usage", "--events"],
      "usage",
    ]);
  } finally {
    delete process.env.RIN_DIR;
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }

  await withAuth(
    { "openai-codex": { type: "oauth", access: "bad", accountId: "owner" } },
    async (agentDir) => {
      const original = globalThis.fetch;
      try {
        globalThis.fetch = (async () => response(500, {})) as typeof fetch;
        await assert.rejects(
          usage.renderUsageReportForChat(agentDir),
          /Codex usage unavailable/,
        );
      } finally {
        globalThis.fetch = original;
      }
    },
  );
  await withAuth(
    { "openai-codex": { type: "oauth", access: "bad", accountId: "owner" } },
    async (agentDir) => {
      const original = globalThis.fetch;
      try {
        globalThis.fetch = (async () => response(200, {})) as typeof fetch;
        await assert.rejects(
          usage.renderUsageReportForChat(agentDir),
          /usage percentage missing/,
        );
      } finally {
        globalThis.fetch = original;
      }
    },
  );
});
