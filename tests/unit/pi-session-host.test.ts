import test from "node:test";
import assert from "node:assert/strict";

import {
  getPiExtensionRunner,
  getPiSessionExtensionMode,
  getPiSessionResourcePromptState,
} from "../../src/core/pi/session-host.js";

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
