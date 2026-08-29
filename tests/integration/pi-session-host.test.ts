import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { AgentSession } from "@earendil-works/pi-coding-agent";

import { importBuiltModule } from "../support/import-built-module.js";

const {
  buildRinCompactionPrompt,
  buildRinCompactionRequest,
  getPiExtensionRunner,
  getPiSessionExtensionMode,
  reloadPiSessionWithActiveTools,
  restorePiSessionActiveToolsForReload,
  resumePiSessionTurn,
  RIN_COMPACTION_PROMPT,
  RIN_COMPACTION_SYSTEM_PROMPT,
  runPiNativeCompactionWithoutFileSummary,
} = await importBuiltModule<typeof import("../../src/core/pi/session-host.js")>(
  "dist/core/pi/session-host.js",
);

test("Pi session host restores an active-tool selection inside reload", async () => {
  const calls: any[] = [];
  const session: any = {
    async reload() {
      calls.push(["reload"]);
      assert.equal(restorePiSessionActiveToolsForReload(session), true);
    },
    setActiveToolsByName(toolNames: string[]) {
      calls.push(["set", toolNames]);
    },
  };

  await reloadPiSessionWithActiveTools(session, ["read"]);

  assert.deepEqual(calls, [["reload"], ["set", ["read"]]]);
  assert.equal(restorePiSessionActiveToolsForReload(session), false);
});

test("Pi session host resumes through the session-level runner", async () => {
  assert.equal(
    typeof (AgentSession.prototype as any)._runAgentPrompt,
    "function",
  );
  const calls: any[] = [];
  const session = {
    marker: "session",
    sessionManager: {},
    agent: { state: { messages: [{ role: "toolResult" }] } },
    async _runAgentPrompt(messages: any[]) {
      calls.push({ receiver: this, messages });
    },
  };

  await resumePiSessionTurn(session, {
    source: "chat-bridge",
    frontendIdentity: { kind: "chat", key: "discord/1:2" },
    promptContext: {
      source: "chat-bridge",
      chatKey: "discord/1:2",
      selfImproveEligible: true,
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].receiver, session);
  assert.deepEqual(calls[0].messages, []);
  assert.deepEqual(session.agent.state.messages, [{ role: "toolResult" }]);
  assert.equal(
    (session.sessionManager as any).__rinLastPromptSource,
    "chat-bridge",
  );
  assert.deepEqual((session.sessionManager as any).__rinFrontend, {
    kind: "chat",
    key: "discord/1:2",
  });
  assert.deepEqual((session.sessionManager as any).__rinLastPromptContext, {
    source: "chat-bridge",
    chatKey: "discord/1:2",
    selfImproveEligible: true,
  });
  await resumePiSessionTurn(session, {
    source: "terminal",
    promptContext: { source: "terminal" },
  });
  assert.equal("__rinFrontend" in session.sessionManager, false);
  await assert.rejects(
    () => resumePiSessionTurn({}),
    /Pi AgentSession continuation runner is unavailable/,
  );
  await assert.rejects(
    () =>
      resumePiSessionTurn({
        agent: { state: { messages: [{ role: "assistant" }] } },
        _runAgentPrompt: async () => {},
      }),
    /Pi AgentSession transcript is not continuable/,
  );
});

test("isolated OAuth custom-compaction smoke preserves public auth and native routing", async () => {
  const model = {
    id: "integration-model",
    name: "Integration Model",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
  };
  const usage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  let prompt = "";
  let systemPrompt = "";
  let requestOptions: any;
  let authModel: any;
  let retrySource: any;
  let responseContent: any[] = [
    { type: "text", text: "## Goal\nKeep native compaction." },
  ];
  let responseStopReason = "stop";
  const session = {
    sessionId: "owner-session",
    model,
    thinkingLevel: "medium",
    agent: {
      streamFunction: async (_model: any, context: any, options: any) => {
        systemPrompt = context.systemPrompt;
        prompt = context.messages[0].content[0].text;
        requestOptions = options;
        return {
          result: async () => ({
            role: "assistant",
            content: responseContent,
            api: "anthropic-messages",
            provider: "anthropic",
            model: "integration-model",
            usage,
            stopReason: responseStopReason,
            timestamp: Date.now(),
          }),
        };
      },
    },
    modelRuntime: {
      async getAuth(requestedModel: any) {
        authModel = requestedModel;
        return {
          auth: {
            apiKey: "oauth-access-token",
            headers: {
              "x-provider-route": "oauth-route",
              "x-deleted-header": null,
            },
          },
          env: { PROVIDER_REGION: "test-region" },
        };
      },
    },
    settingsManager: {
      getRetrySettings: () => undefined,
    },
    _summarizationRetryCallbacks: (source: any) => {
      retrySource = source;
      return undefined;
    },
  };
  const fileOps = {
    read: new Set(["/workspace/read.ts", "/workspace/edit.ts"]),
    written: new Set(["/workspace/new.ts"]),
    edited: new Set(["/workspace/edit.ts"]),
  };
  const event = {
    reason: "threshold",
    customInstructions: undefined,
    signal: new AbortController().signal,
    preparation: {
      firstKeptEntryId: "keep",
      messagesToSummarize: [
        { role: "user", content: "Continue the work.", timestamp: Date.now() },
      ],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 12_000,
      fileOps,
      settings: {
        enabled: true,
        reserveTokens: 2000,
        keepRecentTokens: 20_000,
      },
    },
  };

  const result = await runPiNativeCompactionWithoutFileSummary(session, event);

  assert.deepEqual(retrySource, {
    source: "compaction",
    reason: "threshold",
  });
  assert.equal(authModel, model);
  assert.equal(requestOptions.apiKey, "oauth-access-token");
  assert.deepEqual(requestOptions.headers, {
    "x-provider-route": "oauth-route",
  });
  assert.deepEqual(requestOptions.env, { PROVIDER_REGION: "test-region" });
  assert.equal("maxTokens" in requestOptions, false);
  assert.equal(requestOptions.sessionId, "owner-session");
  assert.equal(requestOptions.cacheRetention, "none");
  assert.equal("toolChoice" in requestOptions, false);
  assert.equal(systemPrompt, RIN_COMPACTION_SYSTEM_PROMPT);
  assert.match(prompt, /## Historical Task Snapshot/);
  assert.match(prompt, /## Completed Actions/);
  assert.match(prompt, /## Active State/);
  assert.match(prompt, /## Errors & Fixes/);
  assert.match(prompt, /## Relevant Files/);
  assert.match(prompt, /Target ~2,000 tokens/);
  assert.match(
    prompt,
    /Later source state and user corrections replace incompatible earlier state/i,
  );
  assert.doesNotMatch(
    prompt,
    /The messages above are a conversation to summarize/,
  );
  assert.equal(result.summary, "## Goal\nKeep native compaction.");
  assert.doesNotMatch(result.summary, /<read-files>|<modified-files>/);
  assert.deepEqual(result.details, {
    readFiles: ["/workspace/read.ts"],
    modifiedFiles: ["/workspace/edit.ts", "/workspace/new.ts"],
  });
  assert.deepEqual(
    [...fileOps.read],
    ["/workspace/read.ts", "/workspace/edit.ts"],
  );

  session.modelRuntime.getAuth = async () => {
    throw new Error("proxy stream owns authentication");
  };
  const proxyResult = await runPiNativeCompactionWithoutFileSummary(
    session,
    event,
  );
  assert.equal(proxyResult.summary, "## Goal\nKeep native compaction.");

  responseStopReason = "length";
  await assert.rejects(
    () => runPiNativeCompactionWithoutFileSummary(session, event),
    /token cap|incomplete/i,
  );
  responseStopReason = "stop";
  responseContent = [
    { type: "toolCall", id: "tool-1", name: "read", arguments: {} },
  ];
  await assert.rejects(
    () => runPiNativeCompactionWithoutFileSummary(session, event),
    /Summarization attempted to call a tool/,
  );
});

test("Rin compaction request preserves preparation while leaving the full prompt to Rin", () => {
  const preparation = {
    firstKeptEntryId: "keep",
    messagesToSummarize: [{ role: "user", content: "new correction" }],
    turnPrefixMessages: [],
    isSplitTurn: false,
    previousSummary: "stale requirement",
  };
  const event = {
    reason: "manual",
    preparation,
    customInstructions: "Preserve exact units.",
  };

  const result = buildRinCompactionRequest(event);

  assert.equal(result.preparation, preparation);
  assert.equal(result.customInstructions, "Preserve exact units.");
  assert.equal(event.customInstructions, "Preserve exact units.");
  const prompt = buildRinCompactionPrompt(
    result.preparation,
    result.customInstructions,
  );
  assert.match(prompt, /PREVIOUS CHECKPOINT:\nstale requirement/);
  assert.match(prompt, /NEW TURNS TO INCORPORATE:\n\[User\]: new correction/);
  assert.match(prompt, /FOCUS TOPIC: Preserve exact units/);
  assert.match(prompt, /60–70% of the checkpoint budget/);
  assert.doesNotMatch(prompt, /Additional focus:/);
  assert.match(RIN_COMPACTION_PROMPT, /## Historical Task Snapshot/);
  assert.match(RIN_COMPACTION_PROMPT, /## Completed Actions/);
  assert.match(RIN_COMPACTION_PROMPT, /## Errors & Fixes/);
  assert.match(RIN_COMPACTION_PROMPT, /## Relevant Files/);
});

test("Pi session host prefers the public extension getter", () => {
  const privateRunner = { mode: "print" };
  const publicRunner = { mode: "rpc" };
  const session = {
    _extensionRunner: privateRunner,
    get extensionRunner() {
      return publicRunner;
    },
  };

  assert.equal(getPiExtensionRunner(session), publicRunner);
  assert.equal(getPiSessionExtensionMode(session), "rpc");
});
