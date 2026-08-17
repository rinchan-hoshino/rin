import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

await import("../support/register-rin-run-owner-fixture.ts");
const run = await import("../../dist/core/rin/run.js");
const owner = globalThis as any;

function resetOwnerState() {
  owner.__rinRunOwnerEvents = [];
  owner.__rinRunOwnerPromptFailure = "";
  owner.__rinRunOwnerPromptDelayMs = 0;
  owner.__rinRunOwnerPromptResult = undefined;
  owner.__rinRunOwnerMessageEvents = [];
  owner.__rinRunOwnerSubscribeReturn = "function";
  owner.__rinRunOwnerAbortFailure = false;
  owner.__rinRunOwnerDisposeFailure = false;
  owner.__rinRunOwnerSessionFile = "";
  owner.__rinRunOwnerSessionId = "session-owner";
}

function parsed(installDir: string) {
  return { installDir } as any;
}

async function captureLogs(action: () => Promise<void>) {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) =>
    logs.push(values.map(String).join(" "));
  try {
    await action();
  } finally {
    console.log = original;
  }
  return logs;
}

test("non-interactive Rin run owns argument normalization, standalone session lifecycle, output, timeout, and cleanup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-run-owner-"));
  const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(
    process.stdin,
    "isTTY",
  );
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: true,
  });
  try {
    const promptFile = path.join(root, "owner-prompt.txt");
    await fs.writeFile(promptFile, "file owner\n", "utf8");

    const rich = await run.parseRunArgs(
      [
        "-p",
        `@${promptFile}`,
        "message owner",
        "follow up",
        "--provider",
        "owner",
        "--model=owner-model",
        "--thinking=high",
        "--mode=json",
        "--name=Owner run",
        "--tools=read,bash",
        "--exclude-tools",
        "bash",
        "--no-builtin-tools",
        "--managed-session-leaf=owner-leaf",
        "--chatKey=owner/bot:room",
        "--timeout=1.25",
      ],
      "stdin owner\n",
    );
    assert.equal(rich.prompt, "stdin owner\nfile owner\nmessage owner");
    assert.deepEqual(rich.messages, ["follow up"]);
    assert.equal(rich.provider, "owner");
    assert.equal(rich.model, "owner/owner-model");
    assert.equal(rich.thinkingLevel, "high");
    assert.equal(rich.outputMode, "json");
    assert.equal(rich.sessionName, "Owner run");
    assert.deepEqual(rich.tools, ["read", "bash"]);
    assert.deepEqual(rich.excludeTools, ["bash"]);
    assert.equal(rich.noTools, "builtin");
    assert.equal(rich.managedSessionLeaf, "owner-leaf");
    assert.equal(rich.chatKey, "owner/bot:room");
    assert.equal(rich.timeoutMs, 1250);
    assert.equal(rich.help, false);
    assert.equal(rich.piStartupOptions.unknownFlags instanceof Map, false);

    const directModel = await run.parseRunArgs(
      ["-p", "owner", "--model", "@direct/model", "--no-tools"],
      "",
    );
    assert.equal(directModel.model, "direct/model");
    assert.equal(directModel.provider, undefined);
    assert.equal(directModel.noTools, "all");
    const noSession = await run.parseRunArgs(
      ["-p", "owner", "--no-session", "--session", "/ignored.jsonl"],
      "",
    );
    assert.equal(noSession.sessionFile, undefined);
    assert.equal(noSession.timeoutMs, 30 * 60 * 1000);

    for (const [argv, message] of [
      [
        ["-p", "owner", "--managed-session"],
        "run_managed_session_value_required",
      ],
      [["-p", "owner", "--chat-key"], "run_chat_key_value_required"],
      [["-p", "owner", "--timeout"], "run_timeout_value_required"],
      [
        ["-p", "owner", "--bind-chat-session"],
        "unknown_run_option:--bind-chat-session",
      ],
      [["-p", "owner", "--timeout=zero"], "invalid_timeout:zero"],
      [["-p", "owner", "--timeout=0"], "invalid_timeout:0"],
      [["-p", "owner", "--model=invalid"], "invalid_model:invalid"],
      [
        ["-p", "owner", "--model=owner/with space"],
        "invalid_model:owner/with space",
      ],
      [
        [
          "-p",
          "owner",
          "--session",
          "/tmp/owner.jsonl",
          "--managed-session=owner",
        ],
        "run_session_conflict",
      ],
    ] as Array<[string[], string]>) {
      await assert.rejects(
        () => run.parseRunArgs(argv, ""),
        new RegExp(message),
      );
    }

    await assert.rejects(
      () =>
        run.runNonInteractive(parsed(root), [
          "-p",
          "owner",
          "--chat-key=owner/bot:room",
        ]),
      /run_chat_key_not_supported_in_print_mode/,
    );
    const helpLogs = await captureLogs(() =>
      run.runNonInteractive(parsed(root), ["-p", "--help"]),
    );
    assert.equal(helpLogs.join("\n").includes("Usage:"), true);
    await assert.rejects(
      () => run.runNonInteractive(parsed(root), ["-p"]),
      /run_prompt_required/,
    );

    resetOwnerState();
    const transientFile = path.join(root, "sessions", "transient-owner.jsonl");
    await fs.mkdir(path.dirname(transientFile), { recursive: true });
    await fs.writeFile(transientFile, "owner", "utf8");
    owner.__rinRunOwnerSessionFile = transientFile;
    owner.__rinRunOwnerPromptResult = {
      result: { ok: true },
      finalText: "event owner final",
    };
    owner.__rinRunOwnerMessageEvents = [
      null,
      { type: "other" },
      { type: "message_end", message: { role: "user", content: "ignored" } },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "event owner final" }],
        },
      },
    ];
    const textLogs = await captureLogs(() =>
      run.runNonInteractive(parsed(root), [
        "-p",
        "first owner",
        "second owner",
        "--provider",
        "owner",
        "--model",
        "owner-model",
        "--thinking",
        "medium",
        "--tools",
        "read",
        "--exclude-tools",
        "bash",
        "--timeout",
        "2",
      ]),
    );
    assert.deepEqual(textLogs, ["event owner final"]);
    assert.equal(
      owner.__rinRunOwnerEvents.some(([name]: string[]) => name === "create"),
      true,
    );
    const configured = owner.__rinRunOwnerEvents.find(
      ([name]: string[]) => name === "configured",
    )[1];
    assert.equal(configured.modelRef, "owner/owner-model");
    assert.equal(configured.thinkingLevel, "medium");
    assert.deepEqual(configured.tools, ["read"]);
    assert.deepEqual(configured.excludeTools, ["bash"]);
    assert.equal(
      owner.__rinRunOwnerEvents.some(
        ([name, text, options]: any[]) =>
          name === "prompt" &&
          text === "first owner\nsecond owner" &&
          options.source === "cli",
      ),
      true,
    );
    assert.equal(
      owner.__rinRunOwnerEvents.some(([name]: string[]) => name === "idle"),
      true,
    );
    assert.equal(
      owner.__rinRunOwnerEvents.some(
        ([name]: string[]) => name === "unsubscribe",
      ),
      true,
    );
    assert.equal(
      owner.__rinRunOwnerEvents.some(([name]: string[]) => name === "abort"),
      true,
    );
    assert.equal(
      owner.__rinRunOwnerEvents.some(([name]: string[]) => name === "dispose"),
      true,
    );
    await assert.rejects(() => fs.access(transientFile), /ENOENT/);

    resetOwnerState();
    owner.__rinRunOwnerSubscribeReturn = "invalid";
    owner.__rinRunOwnerPromptResult = {
      result: { owner: true },
      finalText: "json owner final",
    };
    const managedLogs = await captureLogs(() =>
      run.runNonInteractive(parsed(root), [
        "-p",
        "managed owner",
        "--managed-session",
        "managed-owner",
        "--mode",
        "json",
        "--name",
        "Managed Owner",
      ]),
    );
    assert.equal(managedLogs.length, 1);
    const managedResult = JSON.parse(managedLogs[0]);
    assert.equal(managedResult.finalText, "json owner final");
    assert.deepEqual(managedResult.result, {
      messages: [{ type: "text", text: "json owner final" }],
    });
    assert.equal(managedResult.sessionFile.includes("sessions"), true);
    assert.equal(managedResult.sessionId, "session-owner");

    resetOwnerState();
    const openSession = path.join(root, "existing-owner.jsonl");
    await fs.writeFile(openSession, "{}\n", "utf8");
    const openLogs = await captureLogs(() =>
      run.runNonInteractive(parsed(root), [
        "-p",
        "open owner",
        "--session",
        openSession,
        "--mode=json",
      ]),
    );
    assert.equal(
      owner.__rinRunOwnerEvents.some(([name]: string[]) => name === "open"),
      true,
    );
    assert.equal(JSON.parse(openLogs[0]).sessionFile, openSession);

    resetOwnerState();
    owner.__rinRunOwnerPromptResult = { result: null, finalText: "" };
    await assert.rejects(
      () =>
        captureLogs(() =>
          run.runNonInteractive(parsed(root), ["-p", "missing final"]),
        ),
      /Agent returned an empty response/,
    );

    resetOwnerState();
    owner.__rinRunOwnerPromptFailure = "owner prompt failed";
    owner.__rinRunOwnerAbortFailure = true;
    owner.__rinRunOwnerDisposeFailure = true;
    await assert.rejects(
      () => run.runNonInteractive(parsed(root), ["-p", "failing owner"]),
      /owner prompt failed/,
    );
    assert.equal(
      owner.__rinRunOwnerEvents.some(([name]: string[]) => name === "abort"),
      true,
    );
    assert.equal(
      owner.__rinRunOwnerEvents.some(([name]: string[]) => name === "dispose"),
      true,
    );

    resetOwnerState();
    owner.__rinRunOwnerPromptDelayMs = 50;
    await assert.rejects(
      () =>
        run.runNonInteractive(parsed(root), [
          "-p",
          "timeout owner",
          "--timeout=0.005",
        ]),
      /run_timeout:1/,
    );

    assert.equal(run.shouldRunNonInteractive(["-p"], true), true);
    assert.equal(run.shouldRunNonInteractive(["--mode", "json"], true), true);
    assert.equal(run.shouldRunNonInteractive([], false), true);
  } finally {
    if (stdinIsTtyDescriptor) {
      Object.defineProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
    } else {
      delete (process.stdin as any).isTTY;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
