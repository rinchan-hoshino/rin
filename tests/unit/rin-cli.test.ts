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
const tasks = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "tasks.js")).href
);
const selfImprove = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "self-improve.js"))
    .href
);
const run = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "run.js")).href
);
const main = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "main.js")).href
);
const control = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "control.js")).href
);
const installerMain = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "main.js"))
    .href
);
const updateWorkflow = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "update-workflow.js"),
  ).href
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

test("rin-install update reads target language through elevated installer JSON", () => {
  const installDir = "/home/demo/.rin";
  const language = installerMain.readInstalledUpdateLanguage(
    {
      currentUser: "operator",
      targetUser: "demo",
      installDir,
    },
    {
      readInstallerJson(filePath: string, fallback: any, elevated: boolean) {
        assert.equal(filePath, path.join(installDir, "settings.json"));
        assert.deepEqual(fallback, {});
        assert.equal(elevated, true);
        return { language: "zh_CN" };
      },
    },
  );

  assert.equal(language, "zh_CN");
});

test("rin update is a thin wrapper around rin-install update", () => {
  const source = fs.readFileSync(
    path.join(rootDir, "src", "core", "rin", "shared.ts"),
    "utf8",
  );
  const workflowSource = fs.readFileSync(
    path.join(rootDir, "src", "core", "rin-install", "update-workflow.ts"),
    "utf8",
  );
  const updaterSource = fs.readFileSync(
    path.join(rootDir, "src", "core", "rin-install", "updater.ts"),
    "utf8",
  );

  assert.match(source, /buildRinInstallUpdateArgs/);
  assert.match(source, /dist", "app", "rin-install", "main\.js"/);
  assert.match(source, /"--update"/);
  assert.match(source, /"--target-user"/);
  assert.match(source, /"--install-dir"/);
  assert.match(source, /parsed\.updateAssumeYes/);
  assert.match(source, /parsed\.explicitReleaseChannel/);
  assert.match(source, /parsed\.releaseBranch/);
  assert.match(source, /parsed\.releaseVersion/);
  assert.doesNotMatch(source, /prepareUpdateRuntimeSource/);
  assert.doesNotMatch(source, /confirmUpdateBeforeSourcePreparation/);
  assert.doesNotMatch(source, /bootstrap-entrypoint/);
  assert.match(updaterSource, /prepareUpdateRuntimeSource/);
  assert.match(updaterSource, /rin_update_confirmation_required/);
  assert.match(updaterSource, /isInstalledReleaseCurrent/);
  assert.match(updaterSource, /--preconfirmed/);
  assert.match(workflowSource, /runInstallerProgress/);
  assert.match(workflowSource, /runLoggedUpdateCommandSync/);
  assert.match(workflowSource, /spawn/);
  assert.match(workflowSource, /FORWARDED_UPDATE_SIGNALS/);
  assert.match(workflowSource, /restoreTerminalCursor/);
  assert.match(workflowSource, /--loglevel=error/);
  assert.equal(source.includes("rin update:"), false);
});

test("rin-install update release comparison supports current-version fast path", () => {
  assert.equal(
    updateWorkflow.isInstalledReleaseCurrent(
      { channel: "stable", version: "1.2.3", ref: "old" },
      {
        channel: "stable",
        archiveUrl: "https://example.invalid/rin.tgz",
        version: "1.2.3",
        branch: "stable",
        ref: "new",
        sourceLabel: "stable 1.2.3",
      },
    ),
    true,
  );
  assert.equal(
    updateWorkflow.isInstalledReleaseCurrent(
      { channel: "git", version: "main", ref: "abc123" },
      {
        channel: "git",
        archiveUrl: "https://example.invalid/rin.tgz",
        version: "def456",
        branch: "main",
        ref: "def456",
        sourceLabel: "git branch main @ def456",
      },
    ),
    false,
  );
});

test("rin lifecycle control uses the recorded managed service boundary", () => {
  const source = fs.readFileSync(
    path.join(rootDir, "src", "core", "rin", "control.ts"),
    "utf8",
  );

  assert.match(source, /readManagedRuntimeService/);
  assert.match(
    source,
    /installer\.json does not record a managed runtime service/,
  );
  assert.match(source, /tryManagedSystemdAction\(\[service\.label\]/);
  assert.match(source, /launchctl/);
  assert.match(source, /windows-startup/);
  assert.match(source, /startWindowsDaemonProcess/);
  assert.doesNotMatch(source, /stopManagedBrowseSidecars/);
  assert.match(source, /waitForDaemonUnavailable\(context\)/);
  assert.match(source, /rin_stop_incomplete/);
  assert.doesNotMatch(source, /pkill/);
});

for (const [kind, label, servicePath] of [
  [
    "systemd",
    "rin-daemon-demo.service",
    "/home/demo/.config/systemd/user/rin-daemon-demo.service",
  ],
  [
    "launchd",
    "com.rin.daemon.demo",
    "/Users/demo/Library/LaunchAgents/com.rin.daemon.demo.plist",
  ],
  ["windows-startup", "Rin Daemon", "C:\\Users\\demo\\Startup\\Rin Daemon.cmd"],
] as const) {
  test(`rin lifecycle manifest accepts ${kind} managed service records`, () => {
    const service = control.readManagedRuntimeService({
      installDir: "/opt/rin",
      targetUser: "demo",
      currentUser: "demo",
      readJson(filePath: string, fallback: any) {
        assert.equal(filePath, path.join("/opt/rin", "installer.json"));
        assert.deepEqual(fallback, {});
        return { service: { kind, label, path: servicePath } };
      },
    });

    assert.deepEqual(service, { kind, label, path: servicePath });
  });
}

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
  assert.doesNotMatch(output, /--chat-key <chatKey>/);
  assert.match(output, /--managed-session <leaf>/);
  assert.match(output, /--name <name>/);
  assert.match(output, /--tools <tools>/);
  assert.match(output, /--exclude-tools <tools>/);
  assert.match(output, /--yes/);
  assert.match(
    output,
    /\n\s+self\s+Show recent self-improve distillation runs and details/,
  );
  assert.match(output, /\n\s+tasks\s+Operate scheduled task records/);
  assert.doesNotMatch(output, /\n\s+memory\s+Compatibility alias/);
  assert.doesNotMatch(output, /\n\s+self-improve\s+/);
  assert.doesNotMatch(output, /--bind-chat-session/);
  assert.doesNotMatch(output, /\n\s+run\s+Run one non-interactive Rin turn/);
  assert.doesNotMatch(output, /\n\s+gui\s+/);
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
  assert.doesNotMatch(output, /--chat-key <chatKey>/);
  assert.match(output, /--managed-session <leaf>/);
  assert.match(output, /--name <name>/);
  assert.match(output, /--tools, -t <tools>/);
  assert.match(output, /--exclude-tools, -xt <tools>/);
  assert.doesNotMatch(output, /--bind-chat-session/);
});

test("run parser recognizes legacy chatKey but print mode rejects chat delivery", async () => {
  const parsed = await run.parseRunArgs(
    [
      "-p",
      "hello",
      "--model",
      "@openai/gpt-5.5",
      "--thinking=low",
      "--chat-key",
      "telegram/1:2",
      "--name",
      "daily check",
      "--tools",
      "read,grep",
      "--exclude-tools=grep",
      "--no-builtin-tools",
      "--mode",
      "json",
      "--timeout",
      "12.5",
    ],
    "",
  );

  const { piStartupOptions, ...parsedWithoutPiStartup } = parsed;
  assert.deepEqual(parsedWithoutPiStartup, {
    messages: [],
    prompt: "hello",
    sessionFile: undefined,
    managedSessionLeaf: undefined,
    sessionName: "daily check",
    provider: undefined,
    model: "openai/gpt-5.5",
    thinkingLevel: "low",
    tools: ["read", "grep"],
    excludeTools: ["grep"],
    noTools: "builtin",
    chatKey: "telegram/1:2",
    outputMode: "json",
    timeoutMs: 12500,
    help: false,
  });
  assert.equal(piStartupOptions?.model, "@openai/gpt-5.5");
  assert.equal(piStartupOptions?.thinking, "low");
  assert.deepEqual(piStartupOptions?.excludeTools, ["grep"]);

  await assert.rejects(
    () =>
      run.runNonInteractive(
        shared.resolveParsedArgs("", {}, [
          "-p",
          "hello",
          "--chat-key",
          "telegram/1:2",
        ]),
        ["-p", "hello", "--chat-key", "telegram/1:2"],
      ),
    /run_chat_key_not_supported_in_print_mode/,
  );

  await assert.rejects(
    () => run.parseRunArgs(["-p", "hello", "--bind-chat-session"], ""),
    /unknown_run_option:--bind-chat-session/,
  );

  assert.equal(run.shouldRunNonInteractive(["-p"], true), true);
  assert.equal(run.shouldRunNonInteractive(["--mode", "json"], true), true);
  assert.equal(run.shouldRunNonInteractive([], false), true);

  const runSource = fs.readFileSync(
    path.join(rootDir, "dist", "core", "rin", "run.js"),
    "utf8",
  );
  assert.doesNotMatch(runSource, /requestDaemonCommand/);
  assert.doesNotMatch(runSource, /ensureDaemonAvailable/);
  assert.doesNotMatch(runSource, /chat_run_turn/);
});

test("run parser supports managed session leaves for delegated non-interactive sessions", async () => {
  const parsed = await run.parseRunArgs(
    ["-p", "scout auth", "--managed-session", "subagent", "--name=Scout auth"],
    "",
  );

  assert.equal(parsed.prompt, "scout auth");
  assert.equal(parsed.sessionFile, undefined);
  assert.equal(parsed.managedSessionLeaf, "subagent");
  assert.equal(parsed.sessionName, "Scout auth");
  assert.equal(parsed.piStartupOptions?.name, "Scout auth");

  await assert.rejects(
    () =>
      run.parseRunArgs(
        [
          "-p",
          "hello",
          "--session",
          "/tmp/child.jsonl",
          "--managed-session",
          "subagent",
        ],
        "",
      ),
    /run_session_conflict/,
  );
});

test("usage, status, self, and memory-index parsers ignore wrapper args around the subcommand", () => {
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

  const selfImproveArgs = selfImprove.parseSelfImproveArgs([
    "--user=rin",
    "self",
    "--from",
    "7d",
    "--limit",
    "5",
    "--status",
    "failed",
  ]);
  assert.equal(typeof selfImproveArgs.from, "string");
  assert.equal(selfImproveArgs.limit, 5);
  assert.equal(selfImproveArgs.status, "failed");
  assert.equal(selfImproveArgs.help, false);

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

test("self-improve report renders recent distillation history", () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-report-"),
  );
  try {
    const stateDir = path.join(agentDir, "self_improve", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "maintenance-history.jsonl"),
      [
        {
          id: "run-1",
          kind: "self_improve_review",
          status: "completed",
          trigger: "self_improve:periodic_review",
          sessionFile: path.join(agentDir, "sessions", "demo.jsonl"),
          startedAt: "2026-05-01T00:00:00.000Z",
          finishedAt: "2026-05-01T00:01:00.000Z",
          attempts: 1,
          changedFiles: [
            { path: "self_improve/skills/demo/SKILL.md", change: "updated" },
          ],
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
      "utf8",
    );

    const report = selfImprove.renderSelfImproveReport(agentDir, {
      limit: 10,
      help: false,
    });

    assert.match(report, /Rin self-improve distillation/);
    assert.match(report, /self_improve:periodic_review/);
    assert.match(report, /updated:self_improve\/skills\/demo\/SKILL.md/);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
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
  assert.deepEqual(tasks.parseTasksArgs(["tasks", "reload", "--json"]), {
    action: "reload",
    json: true,
    help: false,
  });
  assert.throws(
    () => tasks.parseTasksArgs(["tasks", "--bad"]),
    /unknown_tasks_arg:--bad/,
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

  const selfHelp = main.resolveInternalRinDispatch([
    "-u",
    "rin",
    "self",
    "--help",
  ]);
  assert.ok(selfHelp);
  assert.equal(selfHelp.run, selfImprove.runSelfImproveInternal);
  assert.deepEqual(selfHelp.args, ["--help"]);

  const removedMemoryAlias = main.resolveInternalRinDispatch([
    "-u",
    "rin",
    "memory",
    "--help",
  ]);
  assert.equal(removedMemoryAlias, undefined);

  const selfImproveInternal = main.resolveInternalRinDispatch([
    "__self_improve_internal",
    "--limit",
    "3",
  ]);
  assert.ok(selfImproveInternal);
  assert.equal(selfImproveInternal.run, selfImprove.runSelfImproveInternal);
  assert.deepEqual(selfImproveInternal.args, ["--limit", "3"]);

  const statusHelp = main.resolveInternalRinDispatch([
    "-u",
    "rin",
    "status",
    "--help",
  ]);
  assert.ok(statusHelp);
  assert.equal(statusHelp.run, status.runStatusInternal);
  assert.deepEqual(statusHelp.args, ["--help"]);

  const tasksHelp = main.resolveInternalRinDispatch([
    "-u",
    "rin",
    "tasks",
    "--help",
  ]);
  assert.ok(tasksHelp);
  assert.equal(tasksHelp.run, tasks.runTasksInternal);
  assert.deepEqual(tasksHelp.args, ["--help"]);
});
