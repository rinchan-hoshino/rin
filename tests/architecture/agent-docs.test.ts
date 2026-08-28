import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
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
  const builtinCapabilities = readAgentDoc("docs/extensions.md");
  const nonInteractiveCli = readAgentDoc("docs/non-interactive-cli.md");
  const piOverrides = readAgentDoc("docs/pi-overrides.md");
  const runtimeLayout = readAgentDoc("docs/runtime-layout.md");
  const scheduledTaskDocNames = fs
    .readdirSync(path.join(rootDir, "docs", "agent", "docs"))
    .filter(
      (name) => name.startsWith("scheduled-tasks") && name.endsWith(".md"),
    )
    .sort();
  assert.deepEqual(scheduledTaskDocNames, [
    "scheduled-tasks-reference.md",
    "scheduled-tasks.md",
  ]);
  const scheduledTasksEntry = readAgentDoc("docs/scheduled-tasks.md");
  const scheduledTasksReference = readAgentDoc(
    "docs/scheduled-tasks-reference.md",
  );
  const selfImproveDistillation = readAgentDoc(
    "docs/self-improve-distillation.md",
  );
  const agentSdk = readAgentDoc("docs/agent-sdk.md");
  const chatBridge = readAgentDoc("docs/chat-bridge.md");
  const richText = readAgentDoc("docs/rich-text-output-format.md");
  const initialization = readAgentDoc("docs/initialization.md");

  assert.match(readme, /Choose the narrow topic document/);
  assert.match(
    readme,
    /execution-environment\.md` only when the live target or capability surface is unclear/,
  );
  assert.match(
    readme,
    /pi-overrides\.md` only when upstream Pi behavior is relevant/,
  );
  assert.match(readme, /docs\/agent-sdk\.md/);
  assert.match(readme, /docs\/scheduled-tasks\.md/);
  assert.match(readme, /docs\/chat-bridge\.md/);
  assert.match(readme, /docs\/initialization\.md/);
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
  assert.doesNotMatch(capabilities, /TUI `\/notes` command/);
  assert.doesNotMatch(capabilities, /scratch work|scratch text buffer/i);
  assert.match(nonInteractiveCli, /--managed-session <leaf>/);
  assert.match(nonInteractiveCli, /sessions\/managed\/<leaf>/);
  assert.match(piOverrides, /## Override contract/);
  assert.match(piOverrides, /## Resolution flow/);
  assert.match(piOverrides, /## Report contract/);
  assert.match(piOverrides, /docs\/self-improve-distillation\.md/);
  assert.match(piOverrides, /Report the effective authority/);
  assert.match(piOverrides, /Behavior semantics:/);
  assert.match(piOverrides, /Current facts:/);
  assert.doesNotMatch(piOverrides, /bundled browse/i);
  assert.match(runtimeLayout, /## Locator contract/);
  assert.match(runtimeLayout, /## Installed runtime entrypoint/);
  assert.match(runtimeLayout, /## Maintenance target contract/);
  assert.match(
    capabilities,
    /`rin update`: the only installed-runtime update command/,
  );
  assert.match(
    capabilities,
    /private payload accepts only its running executor-owned job/,
  );
  assert.match(capabilities, /`rin rollback`: switch to the `previousRelease`/);
  assert.match(runtimeLayout, /## Source checkout boundary/);
  assert.match(runtimeLayout, /## Report contract/);
  assert.match(runtimeLayout, /<targetHome>\/\.rin\/installer\.json/);
  const locatorSection = runtimeLayout
    .split("## Locator contract")[1]
    .split("## Launcher and service contract")[0];
  assert.equal(
    locatorSection.match(/<targetHome>\/\.rin\/installer\.json/g)?.length,
    1,
  );
  assert.match(runtimeLayout, /agent directory/);
  assert.doesNotMatch(runtimeLayout, /<installDir>\/installer\.json/);
  assert.match(runtimeLayout, /app\/current\//);
  assert.match(builtinCapabilities, /Capability source map/);
  assert.match(
    builtinCapabilities,
    /Rin has no separate built-in-extension registry or foreground extension loader/,
  );
  assert.match(
    builtinCapabilities,
    /Browser, computer, mobile, and search operation/,
  );
  assert.doesNotMatch(builtinCapabilities, /provides `run_subagent`/);
  assert.doesNotMatch(capabilities, /bundled `browser_use`/);

  const helperOwnerDocs = [
    ["agent-sdk.md", agentSdk],
    ["scheduled-tasks.md", scheduledTasksEntry],
    ["chat-bridge.md", chatBridge],
  ] as const;
  const assertHelperOwner = (helper: string, expectedOwner: string) => {
    const owners = helperOwnerDocs
      .filter(([, content]) => content.includes(helper))
      .map(([name]) => name);
    assert.deepEqual(owners, [expectedOwner], `${helper} has one doc owner`);
  };

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
    assertHelperOwner(helper, "scheduled-tasks.md");
  }

  for (const helper of [
    "rin.chat.send",
    "rin.chat.runTurn",
    "rin.chat.typing",
    "rin.chat.react",
    "rin.chat.terminateTurn",
    "rin.chat.messages.get",
    "rin.chat.messages.list",
    "rin.chat.evalBridge",
  ]) {
    assertHelperOwner(helper, "chat-bridge.md");
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

  assert.match(agentSdk, /## Method map/);
  assert.match(agentSdk, /## Read more only when needed/);
  assert.match(agentSdk, /Do not read those larger documents for a simple/);
  assert.match(
    agentSdk,
    /\.rin\/app\/current\/dist\/core\/rin-agent-sdk\/index\.js/,
  );
  assert.doesNotMatch(agentSdk, /src\/core\/rin-agent-sdk\/index\.ts/);
  assert.ok(
    agentSdk.length <= 3_200,
    `Agent SDK quick reference is ${agentSdk.length} characters`,
  );
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
  assert.match(chatBridge, /Chat configuration is agent-owned/);
  assert.match(chatBridge, /restart the target daemon/);
  assert.doesNotMatch(chatBridge, /runtime reload\/restart/);
  assert.match(
    chatBridge,
    /confirm the target daemon restarted and loaded the active `~\/\.rin\/settings\.json`/,
  );
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
  assert.match(richText, /SDK import: `docs\/agent-sdk\.md`/);
  assert.match(
    richText,
    /Chat identity, SDK operations, logs, platforms, outbox, and delivery troubleshooting: `docs\/chat-bridge\.md`/,
  );
  assert.match(initialization, /meets a user for the first time/);
  assert.match(initialization, /Success means the user feels welcomed/);
  assert.match(initialization, /current agent role in the user's language/);
  assert.match(
    initialization,
    /infer the most likely language from the available system and conversation context/i,
  );
  assert.match(initialization, /ask which language the user prefers/i);
  assert.match(initialization, /provisional guess/i);
  assert.match(initialization, /Do not read or write `settings\.language`/);
  assert.ok(
    initialization.indexOf("Confirm the conversation language") <
      initialization.indexOf("Establish the agent identity"),
  );
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
  assert.doesNotMatch(initialization, /init-state\.json/);
  assert.doesNotMatch(initialization, /initialization_completed/);
  assert.doesNotMatch(initialization, /initialized.*true|completedAt/);
  assert.match(initialization, /agent_profile/);
  assert.match(initialization, /user_profile/);
  assert.match(
    initialization,
    /chat-platform interoperation and scheduled tasks/,
  );
  assert.match(scheduledTasksEntry, /## Minimal create/);
  assert.match(scheduledTasksEntry, /## Method map/);
  assert.match(
    scheduledTasksEntry,
    /list.*get.*upsert.*run.*wake.*rescheduleOnce.*pause.*resume.*complete.*delete.*reload/s,
  );
  assert.match(
    scheduledTasksEntry,
    /Read `scheduled-tasks-reference\.md` only for/,
  );
  assert.match(
    scheduledTasksEntry,
    /For conditional recurrence, all five must be true/,
  );
  assert.match(
    scheduledTasksEntry,
    /Automatic: set `frontend` and keep `quiet: false`/,
  );
  assert.match(scheduledTasksEntry, /Manual: set `frontend` and `quiet: true`/);
  assert.match(scheduledTasksEntry, /Re-read the task after every mutation/);
  assert.doesNotMatch(
    scheduledTasksEntry,
    /type WritableTaskPatch|type ConditionContext|dedicatedSessionFile/,
  );
  assert.doesNotMatch(
    scheduledTasksEntry,
    /complex polling|polling\/watch|automation extension/i,
  );
  assert.ok(
    scheduledTasksEntry.length <= 7_000,
    `Scheduled-task entry guide is ${scheduledTasksEntry.length} characters`,
  );
  assert.doesNotMatch(scheduledTasksReference, /`session\.mode: "dedicated"`/);
  assert.match(
    scheduledTasksReference,
    /target\.prompt.*target\.continuationPrompt/s,
  );
  assert.match(
    scheduledTasksReference,
    /Reliable task facts, progress, ledgers, and decisions still belong in explicit external state/,
  );
  assert.match(
    scheduledTasksReference,
    /Reliable task facts, progress, ledgers, and decisions still belong in explicit external state/,
  );
  assert.match(scheduledTasksReference, /code: string/);
  assert.match(
    scheduledTasksReference,
    /termination\?: \{ maxRuns\?: number; stopAt\?: string \}/,
  );
  assert.match(scheduledTasksEntry, /## Verification/);
  assert.match(scheduledTasksEntry, /## Task prompt/);
  assert.match(scheduledTasksReference, /Writable task definition/);
  assert.match(scheduledTasksReference, /type WritableTaskPatch/);
  assert.doesNotMatch(
    scheduledTasksReference,
    /disabledRinCapabilities\?: string\[\] \| null/,
  );
  assert.match(scheduledTasksReference, /trigger\?: \{/);
  assert.match(scheduledTasksReference, /target\?:/);
  assert.match(
    scheduledTasksReference,
    /Creating a task requires both `trigger` and `target`; an update with a matching `id` may omit either field/,
  );
  assert.match(scheduledTasksReference, /Read-only lifecycle state/);
  assert.match(
    scheduledTasksReference,
    /condition\?: \{[\s\S]*code: string;[\s\S]*lastEvaluatedAt\?: string;/,
  );
  assert.doesNotMatch(
    scheduledTasksReference,
    /Recurring task is noisy:.*lower `thinkingLevel`/,
  );
  assert.match(scheduledTasksEntry, /`rin-prompt-engineering`/);
  assert.match(
    scheduledTasksReference,
    /target\.prompt.*target\.continuationPrompt/s,
  );
  assert.match(
    scheduledTasksReference,
    /The TUI frontend is the singleton `\{ kind: "tui" \}` identity/,
  );
  assert.match(
    scheduledTasksReference,
    /submits the prompt to that current session/,
  );
  assert.match(
    scheduledTasksReference,
    /Quoting a delivered task message contributes quote rich text only and never selects a session/,
  );
  assert.doesNotMatch(
    scheduledTasksReference,
    /session_continue|current-session continuation/i,
  );
  assert.match(
    scheduledTasksReference,
    /For conditional recurrence, add it only when all five are true/,
  );
  assert.match(scheduledTasksEntry, /## Simple path/);
  assert.match(scheduledTasksReference, /the event time is unknown/);
  assert.match(scheduledTasksReference, /must continue after the current turn/);
  assert.match(
    scheduledTasksReference,
    /most scheduled checks should do nothing/,
  );
  assert.match(
    scheduledTasksReference,
    /the check is cheaper than an agent turn/,
  );
  assert.match(
    scheduledTasksReference,
    /one target action is needed when it becomes true/,
  );
  assert.match(scheduledTasksReference, /## Delivery modes/);
  assert.match(
    scheduledTasksReference,
    /No `frontend`: store the result without automatic delivery/,
  );
  assert.match(
    scheduledTasksReference,
    /`frontend` with `quiet: false`: automatic delivery/,
  );
  assert.match(
    scheduledTasksReference,
    /`frontend` with `quiet: true`: no scheduler-managed delivery/,
  );
  assert.match(
    scheduledTasksReference,
    /Working, interim, independent-error, and final messages are one automatic delivery policy/,
  );
  assert.match(
    scheduledTasksReference,
    /Delivery idempotency and the one-frontend\/one-session invariant are runtime guarantees, not task options/,
  );
  assert.doesNotMatch(
    scheduledTasksReference,
    /complex polling|polling\/watch|automation extension/i,
  );
  assert.doesNotMatch(
    scheduledTasksReference,
    /## Simple path|## Method map|## Minimal create/,
  );
  assert.ok(
    scheduledTasksReference.length <= 15_500,
    `Scheduled-task reference is ${scheduledTasksReference.length} characters`,
  );
  assert.match(selfImproveDistillation, /replay the future trigger/i);
  assert.match(
    selfImproveDistillation,
    /Lessons learned.*outcomes or corrections.*improve future judgment or action.*retain improved behavior/is,
  );
  assert.match(
    selfImproveDistillation,
    /higher-value content replaces or compresses lower-value content before net growth/i,
  );
  assert.match(scheduledTasksEntry, /## Verification/);
});

test("prompt-engineering skill preserves its design and evaluation contract", () => {
  const skill = readAgentDoc("builtin-skills/rin-prompt-engineering/SKILL.md");
  const rubric = readAgentDoc(
    "builtin-skills/rin-prompt-engineering/references/prompt-review-rubric.md",
  );
  const guidance = readAgentDoc(
    "builtin-skills/rin-prompt-engineering/references/authoritative-guidance.md",
  );
  const templates = readAgentDoc(
    "builtin-skills/rin-prompt-engineering/references/prompt-templates.md",
  );
  const packageText = [skill, rubric, guidance, templates].join("\n");
  const behaviorEvals = JSON.parse(
    readAgentDoc("builtin-skills/rin-prompt-engineering/evals/evals.json"),
  ) as {
    skill_name: string;
    evals: Array<{ assertions?: string[] }>;
  };
  const triggerEvals = JSON.parse(
    readAgentDoc(
      "builtin-skills/rin-prompt-engineering/evals/trigger-evals.json",
    ),
  ) as Array<{ should_trigger: boolean }>;

  assert.match(
    skill,
    /description: .*LLM-facing prompts.*prompt\/model migrations.*human prose.*failures already proved outside model behavior/,
  );
  assert.match(skill, /Define (?:measurable )?success/);
  assert.match(skill, /Closed (?:product )?scope/);
  assert.match(skill, /fewest assumptions/);
  assert.match(skill, /set success\/failure thresholds and budgets/);
  assert.match(
    skill,
    /Return (?:only )?the requested artifact|requested artifact is the default output/i,
  );
  assert.match(packageText, /target model(?: and version|\/version)/i);
  assert.match(packageText, /reasoning mode.*sampling/i);
  assert.match(
    packageText,
    /model selection, retrieval, tools, workflow.*fine-tuning/,
  );
  assert.match(packageText, /few-shot examples/);
  assert.match(packageText, /structure.*delimiters|XML structure/i);
  assert.match(packageText, /long[- ]context/i);
  assert.match(packageText, /direct and indirect prompt injection/i);
  assert.match(packageText, /exfiltration|leakage/i);
  assert.match(packageText, /least privilege/i);
  assert.match(packageText, /development.*held-out/i);
  assert.match(packageText, /quality, safety, latency, and cost/i);
  assert.match(packageText, /input, output, cached.*reasoning tokens/i);
  assert.match(packageText, /stable.*dynamic content|stable prefix/i);
  assert.match(packageText, /hidden chain-of-thought/);
  assert.doesNotMatch(skill, /## Four continuous principles/);
  assert.doesNotMatch(rubric, /## Four-principle review/);

  assert.match(guidance, /developers\.openai\.com/);
  assert.match(guidance, /platform\.claude\.com/);
  assert.match(guidance, /cloud\.google\.com/);
  assert.match(guidance, /learn\.microsoft\.com/);
  assert.match(guidance, /prompt-caching/);
  assert.match(guidance, /Retrieved: 2026-08-19/);

  assert.ok(
    Buffer.byteLength(skill, "utf8") <= 3_200,
    "the always-loaded routing and decision core must stay within 3.2 KB",
  );
  assert.match(skill, /from `references\/`/);
  assert.equal(behaviorEvals.skill_name, "rin-prompt-engineering");
  assert.ok(behaviorEvals.evals.length >= 17);
  assert.ok(
    behaviorEvals.evals.every(
      (entry) => Array.isArray(entry.assertions) && entry.assertions.length > 0,
    ),
  );
  assert.equal(
    triggerEvals.filter((entry) => entry.should_trigger).length,
    triggerEvals.filter((entry) => !entry.should_trigger).length,
  );
  assert.ok(triggerEvals.length >= 16);
});
