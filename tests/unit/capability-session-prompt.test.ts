import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const capabilitySession = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-lib", "capability-session.js"),
  ).href
);

test("capability prompt patch does not run before_agent_start for queued streaming prompts", async () => {
  const calls: string[] = [];
  let originalPromptText = "";
  let originalPromptOptions: any = null;
  const session: any = {
    isStreaming: true,
    prompt: async (text: string, options: any) => {
      originalPromptText = text;
      originalPromptOptions = options;
    },
    subscribe: () => () => {},
  };
  const capabilitySet = capabilitySession.createRinCapabilitySet({
    cwd: rootDir,
    agentDir: rootDir,
    definitions: [
      {
        name: "streaming-test",
        hooks: {
          input: [
            async (event: any) => {
              calls.push(`input:${event.streamingBehavior || ""}`);
              return { action: "transform", text: `ctx:${event.text}` };
            },
          ],
          before_agent_start: [
            async () => {
              calls.push("before_agent_start");
              return {
                message: {
                  customType: "should-not-queue",
                  content: "stale",
                  display: false,
                },
              };
            },
          ],
        },
      },
    ],
  });

  await capabilitySession.attachRinCapabilitiesToSession(session, {
    capabilitySet,
  });
  await session.prompt("steer", { streamingBehavior: "steer" });

  assert.deepEqual(calls, ["input:steer"]);
  assert.equal(originalPromptText, "ctx:steer");
  assert.equal(originalPromptOptions.streamingBehavior, "steer");
  assert.deepEqual(session._pendingNextTurnMessages, undefined);
});
