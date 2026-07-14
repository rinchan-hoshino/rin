import test from "node:test";
import assert from "node:assert/strict";
import { AgentSession } from "@earendil-works/pi-coding-agent";

import {
  getPiExtensionRunner,
  getPiSessionExtensionMode,
  getPiSessionResourcePromptState,
  resumePiSessionTurn,
} from "../../src/core/pi/session-host.js";

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
