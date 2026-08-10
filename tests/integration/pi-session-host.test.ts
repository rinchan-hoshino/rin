import test from "node:test";
import assert from "node:assert/strict";
import { AgentSession } from "@earendil-works/pi-coding-agent";

import { importBuiltModule } from "../support/import-built-module.js";

const {
  getPiExtensionRunner,
  getPiSessionExtensionMode,
  getPiSessionResourcePromptState,
  resumePiSessionTurn,
  runPiNativeCompactionWithoutFileSummary,
} = await importBuiltModule<typeof import("../../src/core/pi/session-host.js")>(
  "dist/core/pi/session-host.js",
);

test("Pi session host resumes through the session-level runner", async () => {
  assert.equal(
    typeof (AgentSession.prototype as any)._runAgentPrompt,
    "function",
  );
  const calls: any[] = [];
  const session = {
    marker: "session",
    agent: { state: { messages: [{ role: "toolResult" }] } },
    async _runAgentPrompt(messages: any[]) {
      calls.push({ receiver: this, messages });
    },
  };

  await resumePiSessionTurn(session);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].receiver, session);
  assert.deepEqual(calls[0].messages, []);
  assert.deepEqual(session.agent.state.messages, [{ role: "toolResult" }]);
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
  let requestOptions: any;
  let authModel: any;
  let retrySource: any;
  const session = {
    model,
    thinkingLevel: "medium",
    agent: {
      streamFunction: async (_model: any, context: any, options: any) => {
        prompt = context.messages[0].content[0].text;
        requestOptions = options;
        return {
          result: async () => ({
            role: "assistant",
            content: [
              { type: "text", text: "## Goal\nKeep native compaction." },
            ],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "integration-model",
            usage,
            stopReason: "stop",
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
  assert.equal(typeof requestOptions.sessionId, "string");
  assert.equal(requestOptions.cacheRetention, "none");
  assert.match(prompt, /## Goal/);
  assert.match(prompt, /## Constraints & Preferences/);
  assert.doesNotMatch(prompt, /## Active Task/);
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
});

test("Pi session host prefers public resource and extension getters", () => {
  const privateRunner = { mode: "print" };
  const publicRunner = { mode: "rpc" };
  const privateResourceLoader = {
    agentDir: "private-agent",
    getSystemPrompt: () => "private-system",
    getAppendSystemPrompt: () => ["private-append"],
    getSkills: () => ({ skills: ["private-skill"] }),
    getAgentsFiles: () => ({ agentsFiles: ["private-agent-file"] }),
  };
  const publicResourceLoader = {
    agentDir: "public-agent",
    getSystemPrompt: () => "public-system",
    getAppendSystemPrompt: () => ["public-append"],
    getSkills: () => ({ skills: ["public-skill"] }),
    getAgentsFiles: () => ({ agentsFiles: ["public-agent-file"] }),
  };

  const session = {
    _extensionRunner: privateRunner,
    _resourceLoader: privateResourceLoader,
    get extensionRunner() {
      return publicRunner;
    },
    get resourceLoader() {
      return publicResourceLoader;
    },
  };

  assert.equal(getPiExtensionRunner(session), publicRunner);
  assert.equal(getPiSessionExtensionMode(session), "rpc");
  assert.deepEqual(getPiSessionResourcePromptState(session), {
    agentDir: "public-agent",
    systemPrompt: "public-system",
    appendSystemPrompt: ["public-append"],
    skills: ["public-skill"],
    agentsFiles: ["public-agent-file"],
  });
});
