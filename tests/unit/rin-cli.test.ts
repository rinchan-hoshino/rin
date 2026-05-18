import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const shared = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "shared.js")).href
);
const usage = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "usage.js")).href
);
const memoryIndex = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "memory-index.js"))
    .href
);
const status = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "status.js")).href
);
const run = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "run.js")).href
);
const main = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "main.js")).href
);

test("version subcommand prints package version without launching Rin", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(rootDir, "package.json"), "utf8"),
  );
  const output = execFileSync(
    process.execPath,
    [path.join(rootDir, "dist", "app", "rin", "main.js"), "version"],
    { cwd: rootDir, encoding: "utf8" },
  ).trim();

  assert.equal(output, packageJson.version);
  const parsed = shared.resolveParsedArgs("update", { version: "1.2.3" }, [
    "update",
    "--version",
    "1.2.3",
  ]);
  assert.equal(parsed.releaseVersion, "1.2.3");
});

test("rin update --yes enables non-interactive updater confirmation", () => {
  const parsed = shared.resolveParsedArgs("update", { yes: true }, [
    "update",
    "--yes",
  ]);

  assert.equal(parsed.updateAssumeYes, true);
});

test("rin update pre-installer progress uses installed language", () => {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-update-i18n-"));
  try {
    fs.writeFileSync(
      path.join(installDir, "settings.json"),
      `${JSON.stringify({ language: "zh_CN" })}\n`,
      "utf8",
    );

    const i18n = shared.createUpdateI18n(installDir);

    assert.equal(i18n.displayLanguage, "zh_CN");
    const fetching = "\u6b63\u5728\u83b7\u53d6\u66f4\u65b0\u6e90";
    assert.equal(i18n.fetchingUpdateSourceMessage, fetching);
    assert.equal(
      i18n.preparingUpdateSourceMessage,
      "\u6b63\u5728\u51c6\u5907\u66f4\u65b0\u6e90",
    );
    assert.equal(
      i18n.installingUpdateDependenciesMessage,
      "\u6b63\u5728\u5b89\u88c5\u66f4\u65b0\u4f9d\u8d56",
    );
    assert.equal(
      i18n.buildingUpdateRuntimeMessage,
      "\u6b63\u5728\u6784\u5efa\u66f4\u65b0\u8fd0\u884c\u65f6",
    );
    assert.equal(
      i18n.buildUpdateCommandFailureHeader(fetching),
      "\u6b63\u5728\u83b7\u53d6\u66f4\u65b0\u6e90\u5931\u8d25\uff1b\u6700\u8fd1\u65e5\u5fd7\uff1a",
    );
    assert.equal(
      i18n.formatUpdateSourceLabel("stable latest"),
      "\u7a33\u5b9a\u7248\u6700\u65b0",
    );
  } finally {
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});

test("rin update can read target language through the privileged cross-user path", () => {
  const installDir = "/home/demo/.rin";
  const language = shared.readUpdateDisplayLanguage(installDir, {
    targetUser: "demo",
    currentUser: "operator",
    readJson() {
      throw new Error("current_user_reader_must_not_be_used");
    },
    readPrivilegedJson(filePath: string, fallback: any) {
      assert.equal(filePath, path.join(installDir, "settings.json"));
      assert.deepEqual(fallback, {});
      return { language: "zh_CN" };
    },
  });

  assert.equal(language, "zh_CN");
});

test("rin update delegates final update UI to rin-install update mode", () => {
  const source = fs.readFileSync(
    path.join(rootDir, "src", "core", "rin", "shared.ts"),
    "utf8",
  );

  assert.match(source, /RIN_INSTALL_MODE: "update"/);
  assert.match(source, /RIN_UPDATE_TARGET_USER/);
  assert.match(source, /RIN_UPDATE_INSTALL_DIR/);
  assert.match(source, /RIN_UPDATE_ASSUME_YES/);
  assert.match(source, /RIN_INSTALL_LANGUAGE: i18n\.language/);
  assert.match(source, /createUpdateI18n\(installDir, parsed\.targetUser\)/);
  assert.match(source, /rin-install/);
  assert.match(source, /runInstallerProgress/);
  assert.match(source, /runLoggedUpdateCommandSync/);
  assert.match(source, /--loglevel=error/);
  assert.doesNotMatch(source, /finalizeCoreUpdate/);
  assert.equal(source.includes("rin update:"), false);
});

test("rin updater waits longer for daemon readiness than first install", () => {
  const updaterSource = fs.readFileSync(
    path.join(rootDir, "src", "core", "rin-install", "updater.ts"),
    "utf8",
  );
  const finalizeSource = fs.readFileSync(
    path.join(rootDir, "src", "core", "rin-install", "finalize.ts"),
    "utf8",
  );

  assert.match(updaterSource, /daemonReadyTimeoutMs:\s*30_000/);
  assert.match(finalizeSource, /daemonReadyTimeoutMs/);
  assert.doesNotMatch(finalizeSource, /allowDaemonNotReady/);
});

test("cli help omits removed run command and exposes Pi-style non-interactive flags", () => {
  const output = execFileSync(
    process.execPath,
    [path.join(rootDir, "dist", "app", "rin", "main.js"), "--help"],
    { cwd: rootDir, encoding: "utf8" },
  );

  assert.match(output, /--print/);
  assert.match(output, /--mode <mode>/);
  assert.match(output, /--chat-key <chatKey>/);
  assert.match(output, /--yes/);
  assert.doesNotMatch(output, /--bind-chat-session/);
  assert.doesNotMatch(output, /\n\s+run\s+Run one non-interactive Rin turn/);
  assert.doesNotMatch(output, /--sessions\b/);
  assert.doesNotMatch(output, /--(?:std|rpc)\b/);
});

test("print help shows the Pi-style non-interactive CLI contract", () => {
  const output = execFileSync(
    process.execPath,
    [path.join(rootDir, "dist", "app", "rin", "main.js"), "-p", "--help"],
    { cwd: rootDir, encoding: "utf8" },
  );

  assert.match(
    output,
    /Usage:\n\s+rin \[options\] \[@files\.\.\.\] \[messages\.\.\.\]/,
  );
  assert.match(output, /--print, -p/);
  assert.match(output, /--chat-key <chatKey>/);
  assert.doesNotMatch(output, /--bind-chat-session/);
});

test("run parser supports Pi-style print, model, chatKey, json, and timeout options", async () => {
  const parsed = await run.parseRunArgs(
    [
      "-p",
      "hello",
      "--model",
      "@openai/gpt-5.5",
      "--thinking=low",
      "--chat-key",
      "telegram/1:2",
      "--mode",
      "json",
      "--timeout",
      "12.5",
    ],
    "",
  );

  assert.deepEqual(parsed, {
    messages: [],
    prompt: "hello",
    sessionFile: undefined,
    sessionName: undefined,
    provider: undefined,
    model: "openai/gpt-5.5",
    thinkingLevel: "low",
    chatKey: "telegram/1:2",
    outputMode: "json",
    timeoutMs: 12500,
    help: false,
  });

  await assert.rejects(
    () => run.parseRunArgs(["-p", "hello", "--bind-chat-session"], ""),
    /unknown_run_option:--bind-chat-session/,
  );

  assert.equal(run.shouldRunNonInteractive(["-p"], true), true);
  assert.equal(run.shouldRunNonInteractive(["--mode", "json"], true), true);
  assert.equal(run.shouldRunNonInteractive([], false), true);
});

test("usage, status, and memory-index parsers ignore wrapper args around the subcommand", () => {
  assert.deepEqual(
    usage.parseUsageArgs(["-u", "rin", "usage", "--events", "--limit", "5"]),
    {
      groupBy: [],
      filters: [],
      limit: 5,
      orderBy: "total_tokens",
      direction: "desc",
      events: true,
      includeZero: false,
      dimensions: false,
      help: false,
    },
  );

  assert.deepEqual(
    usage.parseUsageArgs(["--user=rin", "usage", "--events", "--limit", "5"]),
    {
      groupBy: [],
      filters: [],
      limit: 5,
      orderBy: "total_tokens",
      direction: "desc",
      events: true,
      includeZero: false,
      dimensions: false,
      help: false,
    },
  );

  assert.deepEqual(
    usage.parseUsageArgs([
      "usage",
      "--group-by",
      " provider_model , capability ,, ",
      "--filter",
      " source = extension ",
      "--direction",
      " ASC ",
    ]),
    {
      groupBy: ["provider_model", "capability"],
      filters: [{ key: "source", value: "extension" }],
      limit: 20,
      orderBy: "total_tokens",
      direction: "asc",
      events: false,
      includeZero: false,
      dimensions: false,
      help: false,
    },
  );

  assert.deepEqual(
    status.parseStatusArgs([
      "--user=rin",
      "status",
      "--watch",
      "--interval",
      "2.5",
      "--json",
    ]),
    {
      watch: true,
      intervalMs: 2500,
      json: true,
      help: false,
    },
  );

  assert.deepEqual(status.parseStatusArgs(["status", "--interval=0.25"]), {
    watch: false,
    intervalMs: 250,
    json: false,
    help: false,
  });

  assert.deepEqual(memoryIndex.parseMemoryIndexArgs(["memory-index"]), {
    action: "repair",
    help: false,
  });

  assert.deepEqual(
    memoryIndex.parseMemoryIndexArgs(["memory-index", "repair"]),
    {
      action: "repair",
      help: false,
    },
  );

  assert.deepEqual(
    memoryIndex.parseMemoryIndexArgs([
      "memory-index",
      "repair",
      "-u",
      "rin",
      "--help",
    ]),
    {
      action: "repair",
      help: true,
    },
  );

  assert.deepEqual(
    memoryIndex.parseMemoryIndexArgs([
      "--user=rin",
      "memory-index",
      "repair",
      "--help",
    ]),
    {
      action: "repair",
      help: true,
    },
  );
});

test("captureInternalRinCommand forwards only subcommand args", () => {
  const calls = [];
  const result = shared.captureInternalRinCommand(
    {
      repoRoot: "/repo",
      capture(argv) {
        calls.push(argv);
        return "forwarded";
      },
    },
    "__usage_internal",
    ["--user=rin", "usage", "--events", "--limit", "5"],
    "usage",
  );

  assert.equal(result, "forwarded");
  assert.deepEqual(calls, [
    [
      process.execPath,
      path.join("/repo", "dist", "app", "rin", "main.js"),
      "__usage_internal",
      "--events",
      "--limit",
      "5",
    ],
  ]);
});

test("status report renders live worker and cron activity", () => {
  const report = status.renderStatusReport({
    generatedAt: "2026-04-29T01:00:00.000Z",
    socketPath: "/tmp/rin.sock",
    workerCount: 1,
    activeWorkerCount: 1,
    workers: [
      {
        id: "worker_1",
        pid: 123,
        state: "working",
        attachedConnections: 1,
        pendingResponses: 2,
        sessionFile: "/home/rin/.rin/sessions/demo.jsonl",
      },
    ],
    cron: {
      taskCount: 1,
      enabledTaskCount: 1,
      runningTaskCount: 1,
      nextRunAt: "2026-04-29T02:00:00.000Z",
      tasks: [
        {
          id: "cron_demo",
          enabled: true,
          running: true,
          activeDurationMs: 3000,
          runCount: 4,
          nextRunAt: "2026-04-29T02:00:00.000Z",
          session: { mode: "dedicated" },
          target: { kind: "agent_prompt" },
        },
      ],
    },
  });

  assert.match(report, /workers: 1 total, 1 active/);
  assert.match(report, /worker_1/);
  assert.match(report, /cron: 1 tasks, 1 enabled, 1 running/);
  assert.match(report, /cron_demo/);
  assert.match(report, /agent_prompt/);
});

test("usage and status parsers reject invalid syntax", () => {
  assert.throws(
    () => usage.parseUsageArgs(["usage", "--filter", " source= "]),
    /invalid_filter:source=/,
  );
  assert.throws(
    () => usage.parseUsageArgs(["usage", "--session=rin-hidden"]),
    /unknown_usage_arg:--session=rin-hidden/,
  );
  assert.throws(
    () => status.parseStatusArgs(["status", "--bad"]),
    /unknown_status_arg:--bad/,
  );
  assert.throws(
    () => status.parseStatusArgs(["status", "--interval", "--json"]),
    /missing_status_interval/,
  );
  assert.throws(
    () => status.parseStatusArgs(["status", "--interval=soon"]),
    /invalid_status_interval:soon/,
  );
});

test("resolveInternalRinDispatch detects internal markers and wrapped subcommand help", () => {
  const usageHelp = main.resolveInternalRinDispatch([
    "-u",
    "rin",
    "usage",
    "--help",
  ]);
  assert.ok(usageHelp);
  assert.equal(usageHelp.run, usage.runUsageInternal);
  assert.deepEqual(usageHelp.args, ["--help"]);

  const memoryInternal = main.resolveInternalRinDispatch([
    "__memory_index_internal",
    "repair",
  ]);
  assert.ok(memoryInternal);
  assert.equal(memoryInternal.run, memoryIndex.runMemoryIndexInternal);
  assert.deepEqual(memoryInternal.args, ["repair"]);

  const statusHelp = main.resolveInternalRinDispatch([
    "-u",
    "rin",
    "status",
    "--help",
  ]);
  assert.ok(statusHelp);
  assert.equal(statusHelp.run, status.runStatusInternal);
  assert.deepEqual(statusHelp.args, ["--help"]);
});
