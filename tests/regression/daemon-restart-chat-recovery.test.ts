import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const service = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "service.js"))
    .href
);
const { RinDaemonFrontendClient } = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-frontend-sdk", "index.js"),
  ).href
);
const { createConnectedRpcSocketPair } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "platform", "rpc-socket.js"))
    .href
);

async function waitForSocket(socketPath: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection(socketPath);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`socket_not_ready:${socketPath}`);
}

test("normal daemon shutdown arms hosted recovery before classifying worker exits", async () => {
  const source = await fs.readFile(
    path.join(rootDir, "src", "core", "rin-daemon", "daemon.ts"),
    "utf8",
  );
  const hostedShutdown = source.indexOf("options.onShutdown?.()");
  const workerShutdown = source.indexOf("workerPool.beginShutdown()");
  assert.ok(hostedShutdown >= 0, "hosted shutdown hook missing");
  assert.ok(workerShutdown >= 0, "worker shutdown transition missing");
  assert.ok(
    hostedShutdown < workerShutdown,
    "hosted chat recovery must arm before a concurrent worker exit",
  );
  assert.match(source, /resolve\(task\(\)\)/);
});

test("zero-grace shutdown still arms the hosted recovery hook", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-zero-grace-restart-"),
  );
  const socketPath = path.join(directory, "daemon.sock");
  const markerPath = path.join(directory, "hosted-shutdown-armed");
  const launcherPath = path.join(directory, "launcher.mjs");
  const daemonUrl = pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-daemon", "daemon.js"),
  ).href;
  await fs.writeFile(
    launcherPath,
    `import fs from "node:fs";\n` +
      `import { startDaemon } from ${JSON.stringify(daemonUrl)};\n` +
      `await startDaemon({ socketPath: ${JSON.stringify(socketPath)}, shutdownGraceMs: 0, onShutdown: () => fs.writeFileSync(${JSON.stringify(markerPath)}, "armed") });\n`,
  );
  const child = spawn(process.execPath, [launcherPath], {
    cwd: rootDir,
    env: { ...process.env, RIN_DIR: directory },
    stdio: "ignore",
  });
  try {
    await waitForSocket(socketPath);
    const exited = new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    });
    child.kill("SIGTERM");
    await exited;
    assert.equal(await fs.readFile(markerPath, "utf8"), "armed");
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {}
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("explicit daemon disconnect rejects the active prompt immediately", async () => {
  const { clientSocket, serverSocket } = createConnectedRpcSocketPair();
  const client = new RinDaemonFrontendClient({
    socketPath: "inprocess://restart-disconnect",
    connectSocket: async () => clientSocket,
  });
  let outcome = "";
  try {
    await client.connect();
    const pending = client.send({ type: "prompt", message: "active" }).then(
      () => "resolved",
      (error: unknown) => String((error as Error)?.message || error),
    );
    await client.disconnect();
    outcome = await Promise.race([
      pending,
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("disconnect_timeout"), 100),
      ),
    ]);
  } finally {
    for (const entry of (client as any).pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("test_cleanup"));
    }
    (client as any).pending.clear();
    serverSocket.destroy();
  }
  assert.match(outcome, /^rin_disconnected:/);
});

test("hosted restart requeues a concurrent worker exit without committing an error", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-restart-race-"),
  );
  await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n");
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const rootDir = process.env.RIN_REPO_ROOT;
    const agentDir = process.env.RIN_DIR;
    const load = (file) => import(pathToFileURL(path.join(rootDir, file)).href);
    const main = await load("dist/core/chat/main.js");
    const controller = await load("dist/core/chat/controller.js");
    const helpers = await load("dist/core/chat/chat-helpers.js");
    const inbox = await load("dist/core/chat/inbox.js");
    const store = await load("dist/core/chat/message-store.js");
    const support = await load("dist/core/chat/support.js");
    const runtime = await load("dist/core/chat-runtime/index.js");
    support.saveIdentity(path.join(agentDir, "data"), {
      persons: { owner: { trust: "OWNER" } },
      aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
      trusted: [],
    });
    let runTurnCalls = 0;
    let sendCount = 0;
    let rejectFirstTurn;
    controller.ChatController.prototype.runTurn = async function (input) {
      runTurnCalls += 1;
      helpers.markProcessedChatMessage(agentDir, this.chatKey, input.incomingMessageId, {
        acceptedAt: new Date().toISOString(),
      });
      if (runTurnCalls === 1) {
        await new Promise((_, reject) => { rejectFirstTurn = reject; });
      }
      await this.deliverAssistantReply({
        text: "recovered",
        replyToMessageId: input.incomingMessageId,
        incomingMessageId: input.incomingMessageId,
        clearProcessing: true,
        deliveryKind: "final",
      });
      return { finalText: "recovered" };
    };
    controller.ChatController.prototype.detachForDaemonShutdown = async function () {
      rejectFirstTurn?.(new Error("rin_worker_exit"));
    };
    const bot = {
      platform: "telegram",
      selfId: "1",
      async sendMessage() {
        sendCount += 1;
        return ["assistant-" + sendCount];
      },
      internal: { async sendChatAction() {} },
    };
    const first = await main.startChatBridge({ hosted: true });
    first.app.bots.push(bot);
    first.app.emit("message", {
      platform: "telegram",
      selfId: "1",
      channelId: "2",
      userId: "owner-1",
      messageId: "m-restart-race",
      isDirect: true,
      content: "continue after restart",
      stripped: { content: "continue after restart" },
      elements: [runtime.createChatRuntimeH().text("continue after restart")],
    });
    const pending = () => inbox.listPendingChatInboxItems(agentDir);
    const running = () => inbox.listRunningChatInboxItems(agentDir);
    const failed = () => inbox.listChatInboxItems(agentDir, ["failed"]);
    const firstDeadline = Date.now() + 5000;
    while (Date.now() < firstDeadline && runTurnCalls < 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await first.stop();
    const requeueDeadline = Date.now() + 5000;
    while (Date.now() < requeueDeadline && pending().length !== 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const afterStop = store.getChatMessage(agentDir, "telegram/1:2", "m-restart-race");
    const errorsAfterStop = store.listChatMessages(agentDir).filter(
      (item) => item.role === "assistant" && item.deliveryKind === "error",
    );
    if (runTurnCalls !== 1 || afterStop?.processedAt || errorsAfterStop.length || pending().length !== 1 || running().length || failed().length) {
      throw new Error(JSON.stringify({ phase: "stopped", runTurnCalls, afterStop, errorsAfterStop, pending: pending(), running: running(), failed: failed() }));
    }
    const second = await main.startChatBridge({ hosted: true });
    second.app.bots.push(bot);
    const recoveryDeadline = Date.now() + 5000;
    while (Date.now() < recoveryDeadline && runTurnCalls < 2) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    await second.stop();
    const afterRecovery = store.getChatMessage(agentDir, "telegram/1:2", "m-restart-race");
    const assistantRows = store.listChatMessages(agentDir).filter(
      (item) => item.role === "assistant",
    );
    const errors = assistantRows.filter((item) => item.deliveryKind === "error");
    const finals = assistantRows.filter((item) => item.deliveryKind === "final");
    if (runTurnCalls !== 2 || sendCount !== 1 || !afterRecovery?.processedAt || errors.length || finals.length !== 1 || finals[0]?.text !== "recovered" || pending().length || running().length || failed().length) {
      throw new Error(JSON.stringify({ phase: "recovered", runTurnCalls, sendCount, afterRecovery, errors, finals, pending: pending(), running: running(), failed: failed() }));
    }
  `;
  try {
    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: { ...process.env, RIN_REPO_ROOT: rootDir, RIN_DIR: agentDir },
        timeout: 20000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("hosted shutdown detaches every active chat before completion", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-shutdown-arm-all-"),
  );
  await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n");
  const script = `
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const rootDir = process.env.RIN_REPO_ROOT;
    const agentDir = process.env.RIN_DIR;
    const load = (file) => import(pathToFileURL(path.join(rootDir, file)).href);
    const main = await load("dist/core/chat/main.js");
    const controller = await load("dist/core/chat/controller.js");
    const support = await load("dist/core/chat/support.js");
    const runtime = await load("dist/core/chat-runtime/index.js");
    support.saveIdentity(path.join(agentDir, "data"), {
      persons: { owner: { trust: "OWNER" } },
      aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
      trusted: [],
    });
    let runTurnCalls = 0;
    let detachCalls = 0;
    let releaseFirstDetach;
    controller.ChatController.prototype.runTurn = async function () {
      runTurnCalls += 1;
      await new Promise(() => {});
    };
    controller.ChatController.prototype.detachForDaemonShutdown = async function () {
      detachCalls += 1;
      if (detachCalls === 1) {
        await new Promise((resolve) => { releaseFirstDetach = resolve; });
      }
    };
    const bridge = await main.startChatBridge({ hosted: true });
    bridge.app.bots.push({
      platform: "telegram",
      selfId: "1",
      async sendMessage() { return ["assistant"]; },
      internal: { async sendChatAction() {} },
    });
    for (const [channelId, messageId] of [["2", "m-arm-2"], ["3", "m-arm-3"]]) {
      bridge.app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId,
        userId: "owner-1",
        messageId,
        isDirect: true,
        content: "active restart turn",
        stripped: { content: "active restart turn" },
        elements: [runtime.createChatRuntimeH().text("active restart turn")],
      });
    }
    void bridge.runTurn({
      chatKey: "telegram/1:4",
      text: "detached active restart turn",
      controllerKey: "restart-detached",
      affectChatBinding: false,
    });
    const activeDeadline = Date.now() + 5000;
    while (Date.now() < activeDeadline && runTurnCalls < 3) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (runTurnCalls !== 3) throw new Error("three_active_turns_not_started");
    const stopping = bridge.stop();
    const lateTurn = bridge.runTurn({
      chatKey: "telegram/1:5",
      text: "late shutdown turn",
      controllerKey: "late-shutdown-detached",
      affectChatBinding: false,
    }).then(
      () => "resolved",
      (error) => String(error?.message || error),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const lateOutcome = await Promise.race([
      lateTurn,
      Promise.resolve("late_turn_pending"),
    ]);
    const armedBeforeWait = detachCalls;
    const callsBeforeRelease = runTurnCalls;
    releaseFirstDetach?.();
    await stopping;
    if (armedBeforeWait !== 1 || detachCalls !== 3 || callsBeforeRelease !== 3 || lateOutcome !== "rin_frontend_turn_cancelled") {
      throw new Error(JSON.stringify({ armedBeforeWait, detachCalls, callsBeforeRelease, runTurnCalls, lateOutcome }));
    }
    process.exit(0);
  `;
  try {
    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: { ...process.env, RIN_REPO_ROOT: rootDir, RIN_DIR: agentDir },
        timeout: 15000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("managed systemd service reserves SIGTERM for the daemon shutdown owner", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-restart-unit-"),
  );
  try {
    const daemonPath = path.join(
      installDir,
      "app",
      "current",
      "dist",
      "app",
      "rin-daemon",
      "daemon.js",
    );
    const nodePath = path.join(
      installDir,
      "runtime",
      "node",
      "current",
      "bin",
      "node",
    );
    await fs.mkdir(path.dirname(daemonPath), { recursive: true });
    await fs.mkdir(path.dirname(nodePath), { recursive: true });
    await fs.writeFile(daemonPath, "");
    await fs.writeFile(nodePath, "", { mode: 0o755 });

    const spec = service.buildSystemdUserService(
      "restart-owner",
      installDir,
      () => "/home/restart-owner",
    );
    assert.match(spec.service, /^KillMode=mixed$/m);
    assert.doesNotMatch(spec.service, /^KillMode=control-group$/m);
  } finally {
    await fs.rm(installDir, { recursive: true, force: true });
  }
});
