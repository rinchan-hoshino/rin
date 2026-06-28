import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);

function readAgentDoc(relativePath: string) {
  return fs.readFileSync(
    path.join(rootDir, "docs", "agent", relativePath),
    "utf8",
  );
}

test("agent docs expose scheduled task operation workflow", () => {
  const readme = readAgentDoc("README.md");
  const capabilities = readAgentDoc("docs/capabilities.md");
  const executionEnvironment = readAgentDoc("docs/execution-environment.md");
  const builtinCapabilities = readAgentDoc("docs/builtin-extensions.md");
  const sessionAwareness = readAgentDoc("docs/session-awareness.md");
  const nonInteractiveCli = readAgentDoc("docs/non-interactive-cli.md");
  const piOverrides = readAgentDoc("docs/pi-overrides.md");
  const runtimeLayout = readAgentDoc("docs/runtime-layout.md");
  const scheduledTasks = readAgentDoc("docs/scheduled-tasks.md");
  const agentSdk = readAgentDoc("docs/agent-sdk.md");
  const chatBridge = readAgentDoc("docs/chat-bridge.md");
  const richText = readAgentDoc("docs/rich-text-output-format.md");
  const initialization = readAgentDoc("docs/initialization.md");
  const practiceIndex = readAgentDoc("practices/README.md");
  const browserUsePractice = readAgentDoc("practices/browser/README.md");
  const computerUsePractice = readAgentDoc("practices/computer/README.md");
  const mobileUsePractice = readAgentDoc("practices/mobile/README.md");
  const searchPractice = readAgentDoc("practices/search/README.md");

  assert.match(readme, /docs\/agent-sdk\.md/);
  assert.match(readme, /docs\/scheduled-tasks\.md/);
  assert.match(readme, /docs\/chat-bridge\.md/);
  assert.match(readme, /docs\/initialization\.md/);
  assert.match(readme, /practices\/README\.md/);
  assert.match(readme, /practices\/browser\/README\.md/);
  assert.match(readme, /practices\/computer\/README\.md/);
  assert.match(readme, /practices\/mobile\/README\.md/);
  assert.match(readme, /practices\/search\/README\.md/);
  assert.match(capabilities, /agent-sdk\.md/);
  assert.match(capabilities, /scheduled-tasks\.md/);
  assert.match(capabilities, /chat-bridge\.md/);
  assert.match(builtinCapabilities, /agent-sdk\.md/);
  assert.match(builtinCapabilities, /scheduled-tasks\.md/);
  assert.match(capabilities, /Non-interactive child runs/);
  assert.match(executionEnvironment, /## Prompt brief/);
  assert.match(executionEnvironment, /## Live capability contract/);
  assert.match(executionEnvironment, /## Target alignment contract/);
  assert.match(executionEnvironment, /## Validation contract/);
  assert.match(
    executionEnvironment,
    /Documentation examples describe possible capability surfaces/,
  );
  assert.match(executionEnvironment, /docs\/self-improve-distillation\.md/);
  assert.match(capabilities, /memory preserves original evidence/);
  assert.match(capabilities, /self-improve stores distilled guidance/);
  assert.match(capabilities, /docs\/self-improve-distillation\.md/);
  assert.match(sessionAwareness, /## Prompt brief/);
  assert.match(sessionAwareness, /## Owner evidence map/);
  assert.match(sessionAwareness, /## Coordination contract/);
  assert.match(sessionAwareness, /## Freshness contract/);
  assert.match(sessionAwareness, /## Report contract/);
  assert.match(sessionAwareness, /Assign one owner to each write boundary/);
  assert.match(sessionAwareness, /docs\/non-interactive-cli\.md/);
  assert.match(sessionAwareness, /docs\/scheduled-tasks\.md/);
  assert.match(nonInteractiveCli, /--managed-session <leaf>/);
  assert.match(nonInteractiveCli, /sessions\/managed\/<leaf>/);
  assert.match(piOverrides, /## Override contract/);
  assert.match(piOverrides, /## Resolution flow/);
  assert.match(piOverrides, /## Report contract/);
  assert.match(piOverrides, /docs\/self-improve-distillation\.md/);
  assert.match(piOverrides, /Report the effective authority/);
  assert.match(runtimeLayout, /## Locator contract/);
  assert.match(runtimeLayout, /## Installed runtime entrypoint/);
  assert.match(runtimeLayout, /## Maintenance target contract/);
  assert.match(
    capabilities,
    /`rin update --yes`: the only agent-facing installed-runtime update command/,
  );
  assert.match(capabilities, /`rin rollback`: switch to the `previousRelease`/);
  assert.match(runtimeLayout, /## Source checkout boundary/);
  assert.match(runtimeLayout, /## Report contract/);
  assert.match(runtimeLayout, /<targetHome>\/\.rin\/installer\.json/);
  assert.match(runtimeLayout, /agent directory/);
  assert.doesNotMatch(runtimeLayout, /<installDir>\/installer\.json/);
  assert.match(runtimeLayout, /app\/current\//);
  assert.match(builtinCapabilities, /Capability source map/);
  assert.match(
    builtinCapabilities,
    /Rin currently ships no bundled optional foreground extensions/,
  );
  assert.match(
    builtinCapabilities,
    /Browser, computer, mobile, and search operation/,
  );
  assert.doesNotMatch(builtinCapabilities, /provides `run_subagent`/);
  assert.doesNotMatch(builtinCapabilities, /rin:browser-use/);
  assert.doesNotMatch(capabilities, /bundled `browser_use`/);

  assert.match(practiceIndex, /# Agent Practices/);
  assert.match(practiceIndex, /## Route map/);
  assert.match(practiceIndex, /## General contract/);
  assert.match(practiceIndex, /browser\/README\.md/);
  assert.match(practiceIndex, /computer\/README\.md/);
  assert.match(practiceIndex, /mobile\/README\.md/);
  assert.match(practiceIndex, /search\/README\.md/);
  assert.match(practiceIndex, /~\/\.rin\/docs\/rin\/practices\//);
  assert.doesNotMatch(practiceIndex, /Best Practices/i);
  assert.match(browserUsePractice, /Selection rule/);
  assert.match(browserUsePractice, /Brave \+ agent-browser baseline/);
  assert.match(browserUsePractice, /Headful Brave \+ agent-browser/);
  assert.match(browserUsePractice, /Evidence bundle/);
  assert.doesNotMatch(browserUsePractice, /approved browser\/account workflow/);
  assert.doesNotMatch(browserUsePractice, /rinchan-vm-browser-workflow/);
  assert.doesNotMatch(browserUsePractice, /Rin does not ship/);
  assert.match(computerUsePractice, /Selection rule/);
  assert.match(computerUsePractice, /Windows/);
  assert.match(computerUsePractice, /Linux/);
  assert.match(computerUsePractice, /macOS/);
  assert.match(computerUsePractice, /Evidence bundle/);
  assert.doesNotMatch(computerUsePractice, /Rin does not ship/);
  assert.doesNotMatch(computerUsePractice, /approved Windows-agent/);
  assert.doesNotMatch(computerUsePractice, /RinWin11/);
  assert.match(mobileUsePractice, /Android/);
  assert.match(mobileUsePractice, /Evidence bundle/);
  assert.match(searchPractice, /Google URL/);
  assert.match(searchPractice, /SearXNG/);
  assert.match(searchPractice, /Evidence bundle/);

  for (const helper of [
    "rin.tasks.list",
    "rin.tasks.get",
    "rin.tasks.upsert",
    "rin.tasks.reload",
    "rin.tasks.delete",
    "rin.tasks.complete",
    "rin.tasks.pause",
    "rin.tasks.resume",
    "rin.tasks.rescheduleOnce",
    "rin.tasks.run",
    "rin.tasks.wake",
  ]) {
    assert.match(scheduledTasks, new RegExp(helper.replace(/\./g, "\\.")));
    assert.match(agentSdk, new RegExp(helper.replace(/\./g, "\\.")));
  }

  for (const command of [
    "cron_list_tasks",
    "cron_get_task",
    "cron_upsert_task",
    "cron_delete_task",
    "cron_complete_task",
    "cron_run_task",
    "cron_wake_task",
    "cron_pause_task",
    "cron_resume_task",
    "cron_reschedule_once_task",
  ]) {
    assert.doesNotMatch(capabilities, new RegExp(command));
  }

  assert.match(agentSdk, /## Prompt brief/);
  assert.match(agentSdk, /## Success criteria/);
  assert.match(agentSdk, /## Final report contract/);
  assert.match(agentSdk, /"dist", "core", "rin-agent-sdk", "index\.js"/);
  assert.doesNotMatch(agentSdk, /"src", "core", "rin-agent-sdk", "index\.ts"/);
  assert.match(
    chatBridge,
    /The model-level chat bridge tool surface is unavailable/,
  );
  assert.match(chatBridge, /## Boundary selection/);
  assert.match(chatBridge, /platform\/botId:chatId/);
  assert.match(
    chatBridge,
    /Every platform chat key uses the same bot-qualified shape/,
  );
  assert.match(
    chatBridge,
    /Do not introduce platform-specific unqualified forms/,
  );
  assert.match(chatBridge, /Treat platform metadata as authoritative/);
  assert.match(chatBridge, /Chat bridge configuration is agent-owned/);
  assert.match(chatBridge, /restart the target daemon/);
  assert.doesNotMatch(chatBridge, /Use `\/chat`/);
  assert.match(chatBridge, /rin\.chat\.evalBridge/);
  assert.match(chatBridge, /helpers\.useChat\(chatKey\)/);
  assert.match(chatBridge, /chat\.byChatKey/);
  assert.match(chatBridge, /record_only/);
  assert.match(chatBridge, /docs\/rich-text-output-format\.md/);
  assert.match(chatBridge, /data\/chat\/message-store/);
  assert.match(chatBridge, /data\/chat\/eval\/<YYYY-MM-DD>\.jsonl/);
  assert.doesNotMatch(
    chatBridge,
    /Use `docs\/rich-text-output-format\.md` for native mention, quote, attachment, and fallback syntax\.\s*$/,
  );
  assert.match(richText, /Markdown rich-object syntax/);
  assert.match(richText, /`\[@name\]\(at:<platform-user-id>\)`/);
  assert.match(richText, /`\[quote:<message-id>\]`/);
  assert.match(richText, /`!\[alt\]\(url-or-local-path\)`/);
  assert.match(richText, /Structured `parts` for scripts/);
  assert.match(richText, /type: "video" \| "audio" \| "sticker"/);
  assert.match(richText, /## Attachment delivery contract/);
  assert.match(richText, /## Validation checks/);
  assert.match(richText, /chat identity\/log lookup path/);
  assert.match(initialization, /meets a user for the first time/);
  assert.match(initialization, /Success means the user feels welcomed/);
  assert.match(initialization, /current agent role in the user's language/);
  assert.match(initialization, /Ask in sequence, one question at a time/);
  assert.match(initialization, /Make each question easy to answer or defer/);
  assert.match(initialization, /agent name or identity the user wants/);
  assert.match(initialization, /First-meeting flow/);
  assert.match(initialization, /Establish the agent identity/);
  assert.match(
    initialization,
    /Use `docs\/self-improve-distillation\.md` as the persistence contract/,
  );
  assert.match(initialization, /Learn how to address the user/);
  assert.match(initialization, /Learn the desired presence/);
  assert.match(initialization, /Save, summarize, and continue/);
  assert.match(initialization, /init-state\.json/);
  assert.match(initialization, /initialization_completed/);
  assert.match(initialization, /agent_profile/);
  assert.match(initialization, /user_profile/);
  assert.match(
    initialization,
    /chat-platform interoperation and scheduled tasks/,
  );
  assert.match(scheduledTasks, /`session\.mode: "dedicated"`/);
  assert.match(scheduledTasks, /target\.prompt.*target\.continuationPrompt/s);
  assert.match(
    scheduledTasks,
    /Ordinary recurring tasks use external state instead of a dedicated session/,
  );
  assert.match(scheduledTasks, /Store reliable facts, progress, ledgers/);
  assert.match(scheduledTasks, /code: string/);
  assert.match(
    scheduledTasks,
    /termination\?: \{ maxRuns\?: number; stopAt\?: string \}/,
  );
  assert.match(scheduledTasks, /session\.mode: "session_instruction"/);
  assert.match(scheduledTasks, /## Prompt brief/);
  assert.match(scheduledTasks, /## Success criteria/);
  assert.match(scheduledTasks, /Task prompt contract/);
  assert.match(scheduledTasks, /`rin-prompt-engineering`/);
  assert.match(scheduledTasks, /target\.prompt.*target\.continuationPrompt/s);
  assert.match(
    scheduledTasks,
    /Use `condition` when the schedule should wake only if agent-authored TypeScript returns true/,
  );
  assert.match(
    scheduledTasks,
    /Required verification after a create\/update\/run-state change/,
  );
});
