import os from "node:os";
import path from "node:path";

import { completeSimple, isContextOverflow } from "@earendil-works/pi-ai";

import { applyBundledRinExtensionAliases } from "../rin-bundled-extensions.js";
import todoCapability from "./todo.js";
import {
  buildConfiguredLanguageSystemPrompt,
  readConfiguredLanguageFromSettings,
} from "../language.js";
import { loadRinAgentRuntime } from "./agent-runtime.js";
import {
  applyRuntimeProfileEnvironment,
  getRuntimeSessionDir,
  resolveRuntimeProfile,
  RIN_DIR_ENV,
} from "./profile.js";
import memoryModule from "../memory/index.js";
import selfImproveModule from "../self-improve/index.js";
import taskModule from "../task/index.js";
import tokenUsageModule from "../token-usage/index.js";
import chatModule from "../chat/index.js";
import { normalizeFrontendIdentity } from "../rin-frontend-sdk/frontend-identity.js";
import type {
  RinCapabilityDefinition,
  RinCapabilityOptions,
} from "./capability-types.js";
import {
  attachRinCapabilitiesToSession,
  createRinCapabilitySet,
} from "./capability-session.js";
import { compileSelfImproveSync } from "../self-improve/store.js";
import { EPHEMERAL_FORK_DISABLE_ROUTINE_COMPACTION_KEY } from "../session/fork.js";
import { buildSystemPromptSelfImprove } from "../self-improve/format.js";
import { formatPromptContextSystemPromptBlock } from "../rin-frontend-sdk/prompt-context.js";
import type { RinToolStartupOptions } from "./tool-options.js";
import {
  buildProviderBoundContextEvent,
  estimateProviderBoundContextTokens,
  mapMessagesToProviderBoundContext,
} from "./provider-context.js";
import {
  bindPiSessionAutoCompactor,
  bindPiSessionCompactionChecker,
  bindPiSessionSystemPromptRebuilder,
  bindPiSessionToolRegistryRefresher,
  getPiSessionCompactionRequestAuth,
  getPiSessionPromptToolState,
  getPiSessionResourcePromptState,
  patchPiSessionManagerConversationPersistence,
  readPiSessionBaseSystemPrompt,
  replacePiSessionAutoCompactor,
  replacePiSessionCompactionChecker,
  replacePiSessionSystemPromptRebuilder,
  replacePiSessionToolRegistryRefresher,
  runPiSessionAutoCompaction,
  writePiSessionBaseSystemPrompt,
} from "../pi/session-host.js";

const PROMPT_PREFIX = "As the assistant, you must fulfill the user's requests.";

const DEFAULT_PI_GUIDELINES = [
  "Be concise in your responses",
  "Show file paths clearly when working with files",
  "Do not stop after one action if the user's request obviously requires multiple concrete steps",
  "When modifying files, prefer targeted edits and preserve existing style unless asked otherwise",
  "When using bash, explain meaningful findings instead of pasting excessive raw output",
];

function formatCurrentDateForSystemPrompt() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function createRinCapabilityDefinitions(
  options: RinCapabilityOptions,
): RinCapabilityDefinition[] {
  return [
    todoCapability(),
    memoryModule(options),
    selfImproveModule(options),
    taskModule(),
    chatModule(),
    tokenUsageModule(options),
    {
      name: "rin_compaction_prompt",
      hooks: {
        session_before_compact: [
          async (event: any) => {
            return await options.compactWithRinPrompt?.(event);
          },
        ],
      },
    },
    {
      name: "rin_provider_bound_context",
      hooks: {
        context: [(event: any) => buildProviderBoundContextEvent(event)],
      },
    },
  ];
}

function escapeXml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatSkillsForPrompt(skills: any[]) {
  const visibleSkills = (Array.isArray(skills) ? skills : []).filter(
    (skill) => skill && !skill.disableModelInvocation,
  );
  if (!visibleSkills.length) return "";
  const lines = [
    "Available skills provide specialized instructions for specific tasks.",
    "",
    "<available_skills>",
  ];
  for (const skill of visibleSkills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(String(skill.name || ""))}</name>`);
    lines.push(
      `    <description>${escapeXml(String(skill.description || ""))}</description>`,
    );
    lines.push(`    <path>${escapeXml(String(skill?.baseDir || ""))}</path>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

function buildRinRuntimeAwarenessBlock() {
  return "You are running in the Rin runtime environment.";
}

const RIN_COMPACTION_SYSTEM_PROMPT =
  "Create a concise, faithful handoff summary for another LLM continuing the same task. Keep only actionable context. Do not invent facts.";

const RIN_COMPACTION_PROMPT = `Summarize the conversation above as a continuation handoff.

Rules:
- Keep user intent, constraints, authority boundaries, corrections, current state, and next actions.
- Keep exact paths, commands, function names, errors, and decisions only when needed to continue.
- Remove stale, resolved, duplicate, and non-actionable detail.

Use this exact structure:

## Active Task
[Current objective]

## Constraints
- [User requirements, preferences, authority boundaries, corrections]

## Done
- [Completed work]

## Current State
- [Branch/session/runtime state, partial work, blockers]

## Next
1. [Next concrete step]

## Critical Context
- [Only facts/artifacts needed to continue safely]`;

const RIN_TURN_PREFIX_COMPACTION_PROMPT = `This is the prefix of a turn whose suffix will remain in context.

Summarize only what the retained suffix needs:

## Original Request
[What the user asked in this turn]

## Early Progress
- [Key prefix actions and decisions]

## Context for Suffix
- [Facts needed to understand the retained suffix]

Keep it concise. Do not list files unless needed.`;

function extractAssistantText(message: any) {
  return (Array.isArray(message?.content) ? message.content : [])
    .filter((item: any) => item?.type === "text")
    .map((item: any) => String(item.text || ""))
    .join("\n")
    .trim();
}

function createRinSummarizationOptions(
  model: any,
  maxTokens: number,
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
  signal: AbortSignal | undefined,
  thinkingLevel: any,
) {
  const options: any = { maxTokens, apiKey, headers, signal };
  if (model?.reasoning && thinkingLevel && thinkingLevel !== "off") {
    options.reasoning = thinkingLevel;
  }
  return options;
}

type RinCompactionSummaryRequest = {
  model: any;
  promptText: string;
  maxTokens: number;
  apiKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  thinkingLevel?: any;
  streamFn?: any;
};

type RinCompactionSummaryCompleter = (
  options: RinCompactionSummaryRequest,
) => Promise<string>;

async function completeRinCompactionSummary(
  options: RinCompactionSummaryRequest,
) {
  const context: any = {
    systemPrompt: RIN_COMPACTION_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: options.promptText }],
        timestamp: Date.now(),
      },
    ],
  };
  const completionOptions = createRinSummarizationOptions(
    options.model,
    options.maxTokens,
    options.apiKey,
    options.headers,
    options.signal,
    options.thinkingLevel,
  );
  const response = options.streamFn
    ? await (
        await options.streamFn(options.model, context, completionOptions)
      ).result()
    : await completeSimple(options.model, context, completionOptions);
  if (response?.stopReason === "error") {
    throw new Error(
      `Rin compaction summarization failed: ${response.errorMessage || "Unknown error"}`,
    );
  }
  return extractAssistantText(response);
}

const RIN_COMPACTION_PROMPT_SAFETY_TOKENS = 4096;
const RIN_COMPACTION_TRUNCATION_MARKER =
  "\n\n[... truncated to fit compaction summarization budget]";

export function estimateRinCompactionTextTokens(text: string) {
  // Use character count as a conservative prompt-token upper bound. The usual
  // chars/4 heuristic can undercount CJK-heavy chat histories and still let a
  // compaction summary request exceed the provider context window.
  return Array.from(String(text || "")).length;
}

function getRinCompactionPromptBudgetTokens(model: any, maxTokens: number) {
  const contextWindow = Number(model?.contextWindow || 0);
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  const outputTokens = Number(maxTokens || 0);
  const rawBudget =
    contextWindow -
    (Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0) -
    RIN_COMPACTION_PROMPT_SAFETY_TOKENS;
  return Math.max(0, rawBudget);
}

function appendRinCompactionCustomInstructions(
  instruction: string,
  customInstructions?: string,
) {
  const custom = String(customInstructions || "").trim();
  return custom ? `${instruction}\n\nAdditional focus: ${custom}` : instruction;
}

export function buildRinCompactionPromptText(options: {
  conversationText: string;
  instruction: string;
  previousSummary?: string;
}) {
  return [
    `<conversation>\n${options.conversationText || ""}\n</conversation>`,
    options.previousSummary
      ? `<previous-summary>\n${options.previousSummary}\n</previous-summary>`
      : "",
    options.instruction,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function truncateTextToTokenBudget(text: string, tokenBudget: number) {
  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) return "";
  const maxChars = Math.max(0, Math.floor(tokenBudget));
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  const contentBudget = Math.max(
    0,
    maxChars - RIN_COMPACTION_TRUNCATION_MARKER.length,
  );
  return `${chars.slice(0, contentBudget).join("")}${RIN_COMPACTION_TRUNCATION_MARKER}`;
}

function fitRinCompactionPromptToBudget(options: {
  conversationText: string;
  instruction: string;
  previousSummary?: string;
  promptBudgetTokens: number;
}) {
  if (!Number.isFinite(options.promptBudgetTokens)) {
    return buildRinCompactionPromptText(options);
  }

  let previousSummary = String(options.previousSummary || "");
  let conversationText = String(options.conversationText || "");
  let prompt = buildRinCompactionPromptText({
    conversationText,
    instruction: options.instruction,
    previousSummary,
  });
  if (estimateRinCompactionTextTokens(prompt) <= options.promptBudgetTokens) {
    return prompt;
  }

  if (previousSummary) {
    previousSummary = truncateTextToTokenBudget(
      previousSummary,
      Math.floor(options.promptBudgetTokens / 3),
    );
  }

  const promptWithoutConversation = buildRinCompactionPromptText({
    conversationText: "",
    instruction: options.instruction,
    previousSummary,
  });
  const availableConversationTokens = Math.max(
    0,
    options.promptBudgetTokens -
      estimateRinCompactionTextTokens(promptWithoutConversation),
  );
  conversationText = truncateTextToTokenBudget(
    conversationText,
    availableConversationTokens,
  );
  prompt = buildRinCompactionPromptText({
    conversationText,
    instruction: options.instruction,
    previousSummary,
  });

  while (
    estimateRinCompactionTextTokens(prompt) > options.promptBudgetTokens &&
    conversationText.length > 0
  ) {
    conversationText = Array.from(conversationText)
      .slice(0, Math.max(0, Array.from(conversationText).length - 256))
      .join("");
    prompt = buildRinCompactionPromptText({
      conversationText,
      instruction: options.instruction,
      previousSummary,
    });
  }

  while (
    estimateRinCompactionTextTokens(prompt) > options.promptBudgetTokens &&
    previousSummary.length > 0
  ) {
    previousSummary = Array.from(previousSummary)
      .slice(0, Math.max(0, Array.from(previousSummary).length - 256))
      .join("");
    prompt = buildRinCompactionPromptText({
      conversationText,
      instruction: options.instruction,
      previousSummary,
    });
  }

  return prompt;
}

export async function completeRinCompactionSummaryBudgeted(options: {
  model: any;
  messages: any[];
  instruction: string;
  previousSummary?: string;
  maxTokens: number;
  apiKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  thinkingLevel?: any;
  streamFn?: any;
  serializeMessages: (messages: any[]) => string;
  completeSummary?: RinCompactionSummaryCompleter;
  promptBudgetTokens?: number;
}) {
  const completeSummary =
    options.completeSummary || completeRinCompactionSummary;
  const promptBudgetTokens =
    options.promptBudgetTokens ??
    getRinCompactionPromptBudgetTokens(options.model, options.maxTokens);
  const blocks = (Array.isArray(options.messages) ? options.messages : [])
    .map((message) => options.serializeMessages([message]).trim())
    .filter(Boolean);

  let summary = String(options.previousSummary || "").trim();
  if (!blocks.length) return summary;

  let index = 0;
  while (index < blocks.length) {
    const previousSummary = summary || undefined;
    let conversationText = "";

    while (index < blocks.length) {
      const candidate = conversationText
        ? `${conversationText}\n\n${blocks[index]}`
        : blocks[index];
      const candidatePrompt = buildRinCompactionPromptText({
        conversationText: candidate,
        instruction: options.instruction,
        previousSummary,
      });
      const candidateFits =
        !Number.isFinite(promptBudgetTokens) ||
        estimateRinCompactionTextTokens(candidatePrompt) <= promptBudgetTokens;

      if (candidateFits || !conversationText) {
        conversationText = candidate;
        index += 1;
        if (!candidateFits) break;
        continue;
      }
      break;
    }

    const promptText = fitRinCompactionPromptToBudget({
      conversationText,
      instruction: options.instruction,
      previousSummary,
      promptBudgetTokens,
    });
    summary = (
      await completeSummary({
        model: options.model,
        promptText,
        maxTokens: options.maxTokens,
        apiKey: options.apiKey,
        headers: options.headers,
        signal: options.signal,
        thinkingLevel: options.thinkingLevel,
        streamFn: options.streamFn,
      })
    ).trim();
  }

  return summary;
}

function buildRinDocsBlock(agentDir: string) {
  const rinRoot = path.join(agentDir, "docs", "rin");
  const rinDocsRoot = path.join(rinRoot, "docs");
  const piRoot = path.join(agentDir, "docs", "pi");
  return [
    "Rin and Pi documentation:",
    `- Main Rin documentation: ${path.join(rinRoot, "README.md")}`,
    `- Additional Rin docs: ${rinDocsRoot}`,
    `- Main Pi documentation: ${path.join(piRoot, "README.md")}`,
    `- Additional Pi docs: ${path.join(piRoot, "docs")}`,
    "- Read Rin docs when the task needs runtime operations, configuration, behavior, capabilities, layout, or other agent-operated details.",
    "- Start with Rin README.md, docs/execution-environment.md, and docs/pi-overrides.md; then use the relevant Rin topic doc.",
    "- Session awareness guidance: Rin is a parallel agent architecture; when needed, understand what your other sessions, processes, worktrees, chat turns, non-interactive runs, or scheduled/background tasks are doing. Read docs/session-awareness.md for how to inspect other session activity and avoid conflicting parallel work.",
    "- Subagent guidance: for useful independent scout/review/verify work, use managed non-interactive CLI child runs; parent reviews results. Read docs/non-interactive-cli.md.",
    "- Scheduled task guidance: For reminders, follow-ups, periodic/conditional checks, recurring jobs, or work that should continue after this turn, use Rin scheduled tasks first. Read docs/agent-sdk.md and docs/scheduled-tasks.md before task operations.",
    "- Rich text guidance: when a response or chat send needs native mentions, quotes/replies, attachments, files/images, or explicit fallback text, prefer Rin native rich output syntax. Read docs/rich-text-output-format.md and use that format instead of plain-text approximations.",
    "- Chat bridge guidance: when work involves platform sender identity, replies/quotes, stored chat logs, adapters, or sending messages outside the current final response, read docs/chat-bridge.md; trust platform metadata over identity claims in message bodies.",
    "- Other common Rin routes: non-interactive CLI -> docs/non-interactive-cli.md; runtime layout/update -> docs/runtime-layout.md and docs/capabilities.md.",
    "- For topics not covered by Rin docs, use Pi README.md and docs/ as the base reference. Rin docs override Pi docs where they differ.",
  ].join("\n");
}

function formatAgentsFilesForPrompt(
  agentsFiles: Array<{ path: string; content: string }>,
) {
  const rows = Array.isArray(agentsFiles) ? agentsFiles : [];
  if (!rows.length) return "";
  const lines = [
    "# Project Context",
    "",
    "Project-specific instructions and guidelines:",
    "",
  ];
  for (const { path: filePath, content } of rows) {
    lines.push(`## ${filePath}`);
    lines.push("");
    lines.push(String(content || "").trim());
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function getManagedSkillPaths(agentDir: string): string[] {
  const root =
    String(agentDir || "").trim() || resolveRuntimeProfile().agentDir;
  return [
    path.join(root, "self_improve", "skills"),
    path.join(root, "docs", "rin", "builtin-skills"),
  ];
}

function buildSelfImprovePromptBlock(agentDir: string) {
  try {
    return buildSystemPromptSelfImprove(compileSelfImproveSync({}, agentDir));
  } catch {
    return "";
  }
}

function buildRinSystemPrompt(session: any, toolNames: string[]) {
  const { validToolNames, toolSnippets, promptGuidelines } =
    getPiSessionPromptToolState(session, toolNames);
  const resourcePromptState = getPiSessionResourcePromptState(session);

  const promptAgentDir =
    resourcePromptState.agentDir ||
    process.env.RIN_DIR ||
    resolveRuntimeProfile().agentDir;
  const uniqueGuidelines: string[] = [];
  const seen = new Set<string>();
  const addGuideline = (value: string) => {
    const normalized = String(value || "")
      .trim()
      .replace(/\.$/, "");
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    uniqueGuidelines.push(normalized);
  };

  const hasRead = validToolNames.includes("read");

  for (const guideline of [...DEFAULT_PI_GUIDELINES, ...promptGuidelines]) {
    addGuideline(guideline);
  }

  const toolsList =
    validToolNames.length > 0
      ? validToolNames
          .filter((name) => Boolean(toolSnippets[name]))
          .map((name) => `- ${name}: ${toolSnippets[name]}`)
          .join("\n") || "(none)"
      : "(none)";

  const guidelines = uniqueGuidelines.map((g) => `- ${g}`).join("\n");
  const loaderSystemPrompt = resourcePromptState.systemPrompt;
  const appendSystemPrompt =
    resourcePromptState.appendSystemPrompt.length > 0
      ? resourcePromptState.appendSystemPrompt.join("\n\n")
      : "";
  const loadedSkills = resourcePromptState.skills;
  const loadedContextFiles = resourcePromptState.agentsFiles;
  const runtimeAwarenessBlock = buildRinRuntimeAwarenessBlock();
  const docsBlock = buildRinDocsBlock(promptAgentDir);
  const configuredLanguageBlock = buildConfiguredLanguageSystemPrompt(
    readConfiguredLanguageFromSettings(promptAgentDir),
  );
  const selfImprovePromptBlock = buildSelfImprovePromptBlock(promptAgentDir);

  let prompt = String(loaderSystemPrompt || "").trim();
  if (!prompt) {
    prompt = [
      "Available tools:",
      toolsList,
      "",
      "In addition to the tools above, you may have access to other custom tools depending on the project.",
      "",
      "Guidelines:",
      guidelines,
      "",
      docsBlock,
      configuredLanguageBlock ? `\n${configuredLanguageBlock}` : "",
    ].join("\n");
  } else {
    prompt = [prompt, docsBlock, configuredLanguageBlock]
      .filter(Boolean)
      .join("\n\n");
  }

  if (appendSystemPrompt) prompt += `\n\n${appendSystemPrompt}`;

  const agentsBlock = formatAgentsFilesForPrompt(loadedContextFiles);
  if (agentsBlock) {
    prompt += `\n\n${agentsBlock}`;
  }
  if (selfImprovePromptBlock) {
    prompt += `\n\n${selfImprovePromptBlock}`;
  }
  if (hasRead && loadedSkills.length > 0) {
    prompt += `\n\n${formatSkillsForPrompt(loadedSkills)}`;
  }
  prompt = applyPersistedSystemPromptBlocks(
    prompt,
    readPersistedSessionSystemPromptBlocks(session),
  );
  prompt = `${prompt.trimEnd()}\nCurrent date: ${formatCurrentDateForSystemPrompt()}`;
  return `${PROMPT_PREFIX}\n${runtimeAwarenessBlock}\n\n${prompt}`.trimEnd();
}

const LAZY_SYSTEM_PROMPT_STATE_KEY = Symbol.for("rin.lazySystemPromptState");
const SESSION_SYSTEM_PROMPT_ENTRY_TYPE = "rin-system-prompt-state";
const SESSION_SYSTEM_PROMPT_BLOCKS_ENTRY_TYPE = "rin-system-prompt-blocks";

type LazySystemPromptState = {
  materialized: boolean;
  compute: (toolNames: string[]) => string;
  ignorePersistedPrompt: boolean;
};

function getSessionActiveToolNames(session: any): string[] {
  try {
    if (typeof session?.getActiveToolNames === "function") {
      const toolNames = session.getActiveToolNames();
      return Array.isArray(toolNames) ? toolNames : [];
    }
  } catch {}
  return [];
}

function findPersistedSessionBaseSystemPrompt(entries: any[]) {
  if (!Array.isArray(entries)) return "";
  for (const entry of [...entries].reverse()) {
    if (
      entry?.type !== "custom" ||
      String(entry?.customType || "") !== SESSION_SYSTEM_PROMPT_ENTRY_TYPE
    ) {
      continue;
    }
    const prompt = String(entry?.data?.systemPrompt || "");
    if (prompt.trim()) return prompt;
  }
  return "";
}

function readPersistedSessionSystemPromptBlocks(session: any) {
  const entries = session?.sessionManager?.getBranch?.();
  if (!Array.isArray(entries)) return [];
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (
      entry?.type !== "custom" ||
      String(entry?.customType || "") !==
        SESSION_SYSTEM_PROMPT_BLOCKS_ENTRY_TYPE
    ) {
      continue;
    }
    const rows = Array.isArray(entry?.data?.blocks) ? entry.data.blocks : [];
    for (const row of rows) {
      const block = String(row || "").trim();
      if (!block || seen.has(block)) continue;
      seen.add(block);
      blocks.push(block);
    }
  }
  return blocks;
}

function applyPersistedSystemPromptBlocks(prompt: string, blocks: string[]) {
  let next = String(prompt || "").trimEnd();
  for (const block of blocks) {
    const normalized = String(block || "").trim();
    if (!normalized || next.includes(normalized)) continue;
    next = `${next}\n\n${normalized}`.trimEnd();
  }
  return next;
}

function readPersistedSessionBaseSystemPrompt(session: any) {
  const prompt = findPersistedSessionBaseSystemPrompt(
    session?.sessionManager?.getBranch?.(),
  );
  if (!prompt) return "";
  return applyPersistedSystemPromptBlocks(
    prompt,
    readPersistedSessionSystemPromptBlocks(session),
  );
}

function persistSessionBaseSystemPrompt(session: any, systemPrompt: string) {
  const prompt = String(systemPrompt || "");
  if (!prompt.trim()) return;
  if (typeof session?.sessionManager?.appendCustomEntry !== "function") return;
  if (readPersistedSessionBaseSystemPrompt(session) === prompt) return;
  session.sessionManager.appendCustomEntry(SESSION_SYSTEM_PROMPT_ENTRY_TYPE, {
    version: 1,
    systemPrompt: prompt,
  });
}

export function applySessionBaseSystemPrompt(
  session: any,
  systemPrompt: string,
) {
  writePiSessionBaseSystemPrompt(session, systemPrompt);
}

export function clearSessionBaseSystemPrompt(
  session: any,
  options: { ignorePersistedPrompt?: boolean } = {},
) {
  if (!session || typeof session !== "object") return;
  const state = session[LAZY_SYSTEM_PROMPT_STATE_KEY] as
    | LazySystemPromptState
    | undefined;
  if (state && typeof state === "object") {
    state.materialized = false;
    if (options.ignorePersistedPrompt) {
      state.ignorePersistedPrompt = true;
    }
  }
  applySessionBaseSystemPrompt(session, "");
}

export function ensureSessionBaseSystemPrompt(session: any): string {
  if (!session || typeof session !== "object") return "";
  const state = session[LAZY_SYSTEM_PROMPT_STATE_KEY] as
    | LazySystemPromptState
    | undefined;
  if (!state || typeof state.compute !== "function") {
    return readPiSessionBaseSystemPrompt(session);
  }
  if (state.materialized) {
    return readPiSessionBaseSystemPrompt(session);
  }
  if (!state.ignorePersistedPrompt) {
    const persisted = readPersistedSessionBaseSystemPrompt(session);
    if (persisted) {
      state.materialized = true;
      applySessionBaseSystemPrompt(session, persisted);
      return persisted;
    }
  }
  const next = state.compute(getSessionActiveToolNames(session));
  state.materialized = true;
  state.ignorePersistedPrompt = false;
  applySessionBaseSystemPrompt(session, next);
  persistSessionBaseSystemPrompt(session, next);
  return next;
}

export function appendPromptContextSystemPrompt(
  systemPrompt: string,
  promptContext: unknown,
) {
  const block = formatPromptContextSystemPromptBlock(promptContext as any);
  if (!block.trim()) return String(systemPrompt || "");
  const base = String(systemPrompt || "").trimEnd();
  return base ? `${base}\n\n${block}` : block;
}

function applyRinPromptBuilder(session: any) {
  if (!session || typeof session !== "object") return;
  const originalRebuild = bindPiSessionSystemPromptRebuilder(session);
  if (!originalRebuild) return;

  const computePrompt = (toolNames: string[]) => {
    try {
      return buildRinSystemPrompt(
        session,
        Array.isArray(toolNames) ? toolNames : [],
      );
    } catch {
      return originalRebuild(toolNames);
    }
  };

  const state: LazySystemPromptState = {
    materialized: false,
    compute: computePrompt,
    ignorePersistedPrompt: false,
  };
  session[LAZY_SYSTEM_PROMPT_STATE_KEY] = state;

  replacePiSessionSystemPromptRebuilder(session, () => {
    if (!state.materialized) return "";
    return readPiSessionBaseSystemPrompt(session);
  });

  const originalPrompt =
    typeof session.prompt === "function" ? session.prompt.bind(session) : null;
  if (originalPrompt) {
    session.prompt = async (text: string, options?: any) => {
      const basePrompt = ensureSessionBaseSystemPrompt(session);
      const turnPrompt = appendPromptContextSystemPrompt(
        basePrompt,
        options?.promptContext,
      );
      const previousActiveTurnPrompt = session[ACTIVE_TURN_SYSTEM_PROMPT_KEY];
      const activeTurnPrompt: {
        basePrompt: string;
        turnPrompt: string;
        refreshedBasePrompt?: string;
      } = { basePrompt, turnPrompt };
      const frontendIdentity = normalizeFrontendIdentity(
        options?.frontendIdentity,
      );
      if (session.sessionManager && frontendIdentity) {
        session.sessionManager.__rinFrontend = frontendIdentity;
      }
      if (turnPrompt !== basePrompt) {
        session[ACTIVE_TURN_SYSTEM_PROMPT_KEY] = activeTurnPrompt;
        applySessionBaseSystemPrompt(session, turnPrompt);
      }
      try {
        return await originalPrompt(text, options);
      } finally {
        if (turnPrompt !== basePrompt) {
          if (previousActiveTurnPrompt === undefined) {
            delete session[ACTIVE_TURN_SYSTEM_PROMPT_KEY];
          } else {
            session[ACTIVE_TURN_SYSTEM_PROMPT_KEY] = previousActiveTurnPrompt;
          }
        }
        if (turnPrompt !== basePrompt) {
          applySessionBaseSystemPrompt(
            session,
            String(activeTurnPrompt.refreshedBasePrompt || basePrompt),
          );
        }
      }
    };
  }

  const originalReload =
    typeof session.reload === "function" ? session.reload.bind(session) : null;
  if (originalReload) {
    session.reload = async (...args: any[]) => {
      clearSessionBaseSystemPrompt(session, { ignorePersistedPrompt: true });
      const result = await originalReload(...args);
      if (session[ACTIVE_TURN_SYSTEM_PROMPT_KEY]) {
        applySessionBaseSystemPrompt(
          session,
          readCurrentSessionSystemPrompt(session),
        );
      }
      return result;
    };
  }

  clearSessionBaseSystemPrompt(session);
}

const ACTIVE_TURN_SYSTEM_PROMPT_KEY = Symbol.for("rin.activeTurnSystemPrompt");
const AUTO_RELOAD_AFTER_COMPACTION_KEY = Symbol.for(
  "rin.autoReloadAfterCompaction",
);
const COMPACTION_REASON_TRACKING_KEY = Symbol.for(
  "rin.compactionReasonTracking",
);
const COMPACTION_PERCENT_THRESHOLD_KEY = Symbol.for(
  "rin.compactionPercentThreshold",
);
const PROVIDER_OVERFLOW_PREFLIGHT_KEY = Symbol.for(
  "rin.providerOverflowPreflight",
);
const DEFAULT_RIN_COMPACTION_TRIGGER_PERCENT = 0.85;

function normalizeCompactionTriggerPercent(value: unknown) {
  const percent = Number(value);
  if (!Number.isFinite(percent) || percent <= 0 || percent >= 1) {
    return DEFAULT_RIN_COMPACTION_TRIGGER_PERCENT;
  }
  return percent;
}

function shouldTriggerRinPercentCompaction(
  contextTokens: number,
  contextWindow: number,
  settings: any,
) {
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) return false;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return false;
  const triggerPercent = normalizeCompactionTriggerPercent(
    settings?.triggerPercent,
  );
  const reserveTokens = Number(settings?.reserveTokens || 0);
  const reserveThreshold =
    reserveTokens > 0 ? contextWindow - reserveTokens : contextWindow;
  const percentThreshold = Math.floor(contextWindow * triggerPercent);
  const threshold = Math.min(percentThreshold, reserveThreshold);
  return contextTokens >= threshold;
}

function estimateCurrentProviderContextTokens(
  messages: any[],
  helpers: { estimateContextTokens?: (messages: any[]) => any } = {},
) {
  return estimateProviderBoundContextTokens(
    messages || [],
    helpers.estimateContextTokens,
  );
}

export function applyRinPrunedContextUsage(
  session: any,
  helpers: { estimateContextTokens?: (messages: any[]) => any } = {},
) {
  if (!session || typeof session !== "object") return;
  if (session.__rinPrunedContextUsageApplied) return;
  if (typeof session.getContextUsage !== "function") return;
  if (typeof helpers.estimateContextTokens !== "function") return;

  const originalGetContextUsage = session.getContextUsage.bind(session);
  session.getContextUsage = function getRinPrunedContextUsage() {
    const current = originalGetContextUsage();
    if (!current || current.tokens === null) return current;
    const contextWindow = Number(
      current.contextWindow || this.model?.contextWindow || 0,
    );
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) return current;
    const tokens = estimateCurrentProviderContextTokens(this.messages, helpers);
    return {
      ...current,
      tokens,
      percent: (tokens / contextWindow) * 100,
    };
  };
  session.__rinPrunedContextUsageApplied = true;
}

function getSessionProviderContextMessages(session: any) {
  const context = session?.sessionManager?.buildSessionContext?.();
  if (Array.isArray(context?.messages)) return context.messages;
  if (Array.isArray(session?.agent?.state?.messages)) {
    return session.agent.state.messages;
  }
  if (Array.isArray(session?.messages)) return session.messages;
  return [];
}

function mapMessagesToCurrentProviderContext(messages: any[], session: any) {
  return mapMessagesToProviderBoundContext(
    messages,
    getSessionProviderContextMessages(session),
  );
}

function canRunOverflowPreflightFromProviderMessages(messages: any[]) {
  const last = Array.isArray(messages) ? messages[messages.length - 1] : null;
  return Boolean(last && last.role !== "assistant");
}

function syncProviderPreflightMessages(target: any[], source: any[]) {
  if (!Array.isArray(target) || !Array.isArray(source)) return;
  target.splice(0, target.length, ...source);
}

export function applyRinProviderOverflowPreflight(
  session: any,
  helpers: { estimateContextTokens?: (messages: any[]) => any } = {},
) {
  if (!session || typeof session !== "object") return;
  if (session[PROVIDER_OVERFLOW_PREFLIGHT_KEY]) return;
  const agent = session.agent;
  if (!agent || typeof agent !== "object") return;
  if (typeof helpers.estimateContextTokens !== "function") return;

  const originalTransformContext =
    typeof agent.transformContext === "function"
      ? agent.transformContext.bind(agent)
      : undefined;
  if (!originalTransformContext) return;

  let lastPreflightTailMessage: any = undefined;
  agent.transformContext = async function rinOverflowPreflightTransformContext(
    messages: any[],
    signal?: AbortSignal,
  ) {
    let providerMessages = await originalTransformContext(messages, signal);
    if (!canRunOverflowPreflightFromProviderMessages(providerMessages)) {
      return providerMessages;
    }
    const settings = session.settingsManager?.getCompactionSettings?.();
    if (!settings?.enabled || session.isCompacting) return providerMessages;

    const contextWindow = Number(session.model?.contextWindow || 0);
    const contextTokens = estimateCurrentProviderContextTokens(
      providerMessages,
      helpers,
    );
    if (
      !shouldTriggerRinPercentCompaction(contextTokens, contextWindow, settings)
    ) {
      return providerMessages;
    }

    const tailMessage = Array.isArray(messages)
      ? messages[messages.length - 1]
      : undefined;
    if (tailMessage && tailMessage === lastPreflightTailMessage) {
      return providerMessages;
    }
    lastPreflightTailMessage = tailMessage;

    const compacted = await runPiSessionAutoCompaction(
      session,
      "overflow",
      true,
    );
    if (!compacted) return providerMessages;

    const refreshedMessages = getSessionProviderContextMessages(session);
    syncProviderPreflightMessages(messages, refreshedMessages);
    providerMessages = await originalTransformContext(
      refreshedMessages,
      signal,
    );
    return providerMessages;
  };

  session[PROVIDER_OVERFLOW_PREFLIGHT_KEY] = { originalTransformContext };
}

export function applyRinCompactionPercentThreshold(
  session: any,
  helpers: {
    calculateContextTokens?: (usage: any) => number;
    estimateContextTokens?: (messages: any[]) => any;
    getLatestCompactionEntry?: (entries: any[]) => any;
  } = {},
) {
  if (!session || typeof session !== "object") return;
  if (session[COMPACTION_PERCENT_THRESHOLD_KEY]) return;
  const originalCheckCompaction = bindPiSessionCompactionChecker(session);
  const originalRunAutoCompaction = bindPiSessionAutoCompactor(session);
  if (!originalCheckCompaction || !originalRunAutoCompaction) return;
  if (typeof helpers.calculateContextTokens !== "function") return;
  if (typeof helpers.estimateContextTokens !== "function") return;

  replacePiSessionCompactionChecker(
    session,
    async function patchedRinPercentCompaction(
      assistantMessage: any,
      skipAbortedCheck = true,
    ) {
      const settings = this.settingsManager?.getCompactionSettings?.();
      if (!settings?.enabled) {
        return await originalCheckCompaction(
          assistantMessage,
          skipAbortedCheck,
        );
      }
      if (skipAbortedCheck && assistantMessage?.stopReason === "aborted") {
        return await originalCheckCompaction(
          assistantMessage,
          skipAbortedCheck,
        );
      }
      const contextWindow = Number(this.model?.contextWindow || 0);
      const compactionEntry = helpers.getLatestCompactionEntry?.(
        this.sessionManager?.getBranch?.() || [],
      );
      if (
        compactionEntry &&
        assistantMessage?.timestamp <=
          new Date(compactionEntry.timestamp).getTime()
      ) {
        return false;
      }

      const sameModel =
        this.model &&
        assistantMessage?.provider === this.model.provider &&
        assistantMessage?.model === this.model.id;
      if (
        assistantMessage?.stopReason === "error" &&
        sameModel &&
        isContextOverflow(assistantMessage, contextWindow)
      ) {
        return await originalCheckCompaction(
          assistantMessage,
          skipAbortedCheck,
        );
      }

      const contextTokens =
        assistantMessage?.stopReason === "error"
          ? estimateCurrentProviderContextTokens(
              this.agent?.state?.messages,
              helpers,
            )
          : helpers.calculateContextTokens(assistantMessage?.usage);
      if (
        shouldTriggerRinPercentCompaction(
          contextTokens,
          contextWindow,
          settings,
        )
      ) {
        return await runPiSessionAutoCompaction(this, "threshold", false);
      }
      return false;
    },
  );

  session[COMPACTION_PERCENT_THRESHOLD_KEY] = { originalCheckCompaction };
}

export function applyRinCompactionReasonTracking(session: any) {
  if (!session || typeof session !== "object") return;
  if ((session as any)[COMPACTION_REASON_TRACKING_KEY]) return;
  const withReason = async <T>(reason: string, run: () => Promise<T>) => {
    const previous = session.__rinCurrentCompactionReason;
    session.__rinCurrentCompactionReason = String(reason || "").trim();
    try {
      return await run();
    } finally {
      if (previous === undefined) delete session.__rinCurrentCompactionReason;
      else session.__rinCurrentCompactionReason = previous;
    }
  };

  const originalRunAutoCompaction = bindPiSessionAutoCompactor(session);
  if (originalRunAutoCompaction) {
    replacePiSessionAutoCompactor(
      session,
      async function patchedRunAutoCompaction(reason: string, ...args: any[]) {
        return await withReason(String(reason || "auto"), () =>
          originalRunAutoCompaction(reason, ...args),
        );
      },
    );
  }

  const originalCompact =
    typeof session.compact === "function"
      ? session.compact.bind(session)
      : null;
  if (originalCompact) {
    session.compact = async function patchedManualCompactionReason(
      ...args: any[]
    ) {
      return await withReason("manual", () => originalCompact(...args));
    };
  }

  if (!originalRunAutoCompaction && !originalCompact) return;

  (session as any)[COMPACTION_REASON_TRACKING_KEY] = {
    originalRunAutoCompaction,
    originalCompact,
  };
}

function mergeActiveTurnSystemPrompt(session: any, basePrompt: string) {
  const active = session?.[ACTIVE_TURN_SYSTEM_PROMPT_KEY];
  if (!active || typeof active !== "object") return basePrompt;

  const originalBase = String(active.basePrompt || "");
  const originalTurn = String(active.turnPrompt || "");
  if (!originalTurn || originalTurn === originalBase) return basePrompt;

  active.refreshedBasePrompt = basePrompt;

  let suffix = "";
  if (originalBase && originalTurn.startsWith(originalBase)) {
    suffix = originalTurn.slice(originalBase.length).trim();
  } else if (!originalBase) {
    suffix = originalTurn.trim();
  }
  if (!suffix || basePrompt.includes(suffix)) return basePrompt;
  return `${String(basePrompt || "").trimEnd()}\n\n${suffix}`.trimEnd();
}

function readCurrentSessionSystemPrompt(session: any) {
  try {
    return mergeActiveTurnSystemPrompt(
      session,
      ensureSessionBaseSystemPrompt(session),
    );
  } catch {
    return mergeActiveTurnSystemPrompt(
      session,
      String(readPiSessionBaseSystemPrompt(session)),
    );
  }
}

export function applyAutoReloadAfterCompaction(session: any) {
  if (!session || typeof session !== "object") return;
  if ((session as any)[AUTO_RELOAD_AFTER_COMPACTION_KEY]) return;
  if (typeof session.subscribe !== "function") return;
  if (typeof session.reload !== "function") return;

  let reloadInFlight: Promise<void> | null = null;
  let reloadQueued = false;

  const runReload = () => {
    if (reloadInFlight) {
      reloadQueued = true;
      return reloadInFlight;
    }

    reloadInFlight = (async () => {
      try {
        await session.reload();
      } catch {}
    })().finally(() => {
      reloadInFlight = null;
      if (!reloadQueued) return;
      reloadQueued = false;
      setTimeout(() => {
        void runReload();
      }, 0);
    });

    return reloadInFlight;
  };

  let compactionDepth = 0;
  let pendingCompactionReload = false;

  const finishCompactionReload = async () => {
    compactionDepth -= 1;
    if (compactionDepth > 0 || !pendingCompactionReload) return;
    pendingCompactionReload = false;
    await runReload();
  };

  const originalRunAutoCompaction = bindPiSessionAutoCompactor(session);
  if (originalRunAutoCompaction) {
    replacePiSessionAutoCompactor(
      session,
      async function patchedAutoReloadCompaction(...args: any[]) {
        compactionDepth += 1;
        try {
          return await originalRunAutoCompaction(...args);
        } finally {
          await finishCompactionReload();
        }
      },
    );
  }

  const originalCompact =
    typeof session.compact === "function"
      ? session.compact.bind(session)
      : null;
  if (originalCompact) {
    session.compact = async function patchedManualReloadCompaction(
      ...args: any[]
    ) {
      compactionDepth += 1;
      try {
        return await originalCompact(...args);
      } finally {
        await finishCompactionReload();
      }
    };
  }

  const unsubscribe = session.subscribe((event: any) => {
    if (event?.type !== "compaction_end") return;
    if (event?.aborted || !event?.result) return;
    if (compactionDepth > 0) {
      pendingCompactionReload = true;
      return;
    }
    void runReload();
  });

  (session as any)[AUTO_RELOAD_AFTER_COMPACTION_KEY] = {
    unsubscribe,
    originalRunAutoCompaction,
    originalCompact,
  };
}

export {
  applyRuntimeProfileEnvironment,
  getRuntimeSessionDir,
  resolveRuntimeProfile,
  RIN_DIR_ENV,
};

const RIN_RUNTIME_SESSION_SHUTDOWN_KEY = Symbol.for(
  "rin.runtimeSessionShutdown",
);

function hasRinCapabilityHandlers(session: any, type: string) {
  const capabilitySet = session?.__rinCapabilities;
  if (!type || !capabilitySet || typeof capabilitySet.emit !== "function") {
    return false;
  }
  if (typeof capabilitySet.hasHandlers !== "function") return true;
  return capabilitySet.hasHandlers(type);
}

async function emitRinCapabilityEvent(session: any, event: any) {
  const type = String(event?.type || "").trim();
  if (!hasRinCapabilityHandlers(session, type)) return;
  const frontend = normalizeFrontendIdentity(
    event?.frontend ?? session?.sessionManager?.__rinFrontend,
  );
  await session.__rinCapabilities.emit(
    frontend ? { ...event, frontend } : event,
  );
}

async function emitRinSessionShutdown(session: any, event: any) {
  await emitRinCapabilityEvent(session, {
    type: "session_shutdown",
    ...(event || {}),
  });
}

export function patchRinRuntimeSessionShutdown(runtime: any) {
  if (!runtime || typeof runtime !== "object") return;
  if (runtime[RIN_RUNTIME_SESSION_SHUTDOWN_KEY]) return;

  const originalTeardownCurrent =
    typeof runtime.teardownCurrent === "function"
      ? runtime.teardownCurrent.bind(runtime)
      : null;
  if (originalTeardownCurrent) {
    runtime.teardownCurrent = async (
      reason: string,
      targetSessionFile?: string,
    ) => {
      await emitRinSessionShutdown(runtime.session, {
        reason,
        targetSessionFile,
      });
      return await originalTeardownCurrent(reason, targetSessionFile);
    };
  }

  const originalDispose =
    typeof runtime.dispose === "function"
      ? runtime.dispose.bind(runtime)
      : null;
  if (originalDispose) {
    runtime.dispose = async (...args: any[]) => {
      await emitRinSessionShutdown(runtime.session, { reason: "quit" });
      return await originalDispose(...args);
    };
  }

  runtime[RIN_RUNTIME_SESSION_SHUTDOWN_KEY] = {
    originalTeardownCurrent,
    originalDispose,
  };
}

const BACKEND_TOOL_EXECUTION_LOCKS_KEY = Symbol.for(
  "rin.backendToolExecutionLocks",
);
const BACKEND_TOOL_LOCK_WRAPPED_KEY = Symbol.for(
  "rin.backendToolExecutionLockWrapped",
);
const backendToolExecutionQueues = new Map<
  string,
  ReturnType<typeof createSerialExecutionQueue>
>();

function normalizeQueueMode(value: unknown, fallback: "all" | "one-at-a-time") {
  return value === "all" || value === "one-at-a-time" ? value : fallback;
}

function createSerialExecutionQueue() {
  let tail: Promise<void> = Promise.resolve();
  return async function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    let release = () => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = tail;
    tail = tail.then(
      () => next,
      () => next,
    );
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

export function applyRinBackendToolExecutionLocks(
  session: any,
  toolNames = ["web_search"],
) {
  if (!session || typeof session !== "object") return;
  const targetNames = new Set(
    toolNames.map((name) => String(name || "").trim()).filter(Boolean),
  );
  if (!targetNames.size) return;

  const existingState = session[BACKEND_TOOL_EXECUTION_LOCKS_KEY] as
    | {
        targetNames: Set<string>;
        patched: boolean;
      }
    | undefined;
  const state = existingState || {
    targetNames: new Set<string>(),
    patched: false,
  };
  for (const name of targetNames) state.targetNames.add(name);
  session[BACKEND_TOOL_EXECUTION_LOCKS_KEY] = state;

  const getQueue = (name: string) => {
    let queue = backendToolExecutionQueues.get(name);
    if (!queue) {
      queue = createSerialExecutionQueue();
      backendToolExecutionQueues.set(name, queue);
    }
    return queue;
  };

  const wrapTool = (tool: any) => {
    const name = String(tool?.name || "").trim();
    if (!name || !state.targetNames.has(name)) return tool;
    if (tool?.[BACKEND_TOOL_LOCK_WRAPPED_KEY]) return tool;
    if (typeof tool?.execute !== "function") return tool;
    const runExclusive = getQueue(name);
    return {
      ...tool,
      [BACKEND_TOOL_LOCK_WRAPPED_KEY]: true,
      execute: (...args: any[]) =>
        runExclusive(() => tool.execute.call(tool, ...args)),
    };
  };

  const wrapActiveTools = () => {
    const tools = session?.agent?.state?.tools;
    if (!Array.isArray(tools)) return;
    let changed = false;
    const nextTools = tools.map((tool) => {
      const nextTool = wrapTool(tool);
      if (nextTool !== tool) changed = true;
      return nextTool;
    });
    if (changed) session.agent.state.tools = nextTools;
  };

  if (!state.patched) {
    const originalSetActiveToolsByName =
      typeof session.setActiveToolsByName === "function"
        ? session.setActiveToolsByName.bind(session)
        : null;
    if (originalSetActiveToolsByName) {
      session.setActiveToolsByName = (...args: any[]) => {
        const result = originalSetActiveToolsByName(...args);
        wrapActiveTools();
        return result;
      };
    }

    const originalRefreshToolRegistry =
      bindPiSessionToolRegistryRefresher(session);
    if (originalRefreshToolRegistry) {
      replacePiSessionToolRegistryRefresher(session, (...args: any[]) => {
        const result = originalRefreshToolRegistry(...args);
        wrapActiveTools();
        return result;
      });
    }
    state.patched = true;
  }

  wrapActiveTools();
}

export function applyRinSettingsDefaults(settingsManager: any) {
  if (!settingsManager || settingsManager.__rinSettingsDefaultsApplied) return;
  settingsManager.__rinSettingsDefaultsApplied = true;
  if (typeof settingsManager.getSteeringMode === "function") {
    settingsManager.getSteeringMode = function getRinSteeringModeDefaultAll() {
      return normalizeQueueMode(this.settings?.steeringMode, "all");
    };
  }
}

function applyStartupSessionName(sessionManager: any, sessionName?: unknown) {
  const name = String(sessionName || "").trim();
  if (!name || typeof sessionManager?.appendSessionInfo !== "function") return;
  const current = String(sessionManager.getSessionName?.() || "").trim();
  if (current === name) return;
  sessionManager.appendSessionInfo(name);
}

export async function createConfiguredAgentSession(
  options: RinToolStartupOptions & {
    cwd?: string;
    agentDir?: string;
    additionalExtensionPaths?: string[];
    noExtensions?: boolean;
    extensionFlagValues?: Map<string, boolean | string>;
    additionalSkillPaths?: string[];
    noSkills?: boolean;
    additionalPromptTemplatePaths?: string[];
    noPromptTemplates?: boolean;
    additionalThemePaths?: string[];
    noThemes?: boolean;
    noContextFiles?: boolean;
    systemPrompt?: string;
    appendSystemPrompt?: string[];
    disabledRinCapabilities?: string[];
    sessionManager?: any;
    sessionName?: string;
    modelRef?: string;
    thinkingLevel?: any;
  } = {},
) {
  const agentRuntimeModule = await loadRinAgentRuntime();
  const {
    calculateContextTokens,
    convertToLlm,
    createAgentSessionRuntime,
    createAgentSessionServices,
    createAgentSessionFromServices,
    estimateContextTokens,
    getLatestCompactionEntry,
    serializeConversation,
    SettingsManager,
    SessionManager,
  } = agentRuntimeModule as any;

  const { cwd, agentDir } = resolveRuntimeProfile({
    cwd: options.cwd,
    agentDir: options.agentDir,
  });
  const managedSkillPaths = getManagedSkillPaths(agentDir);
  const additionalSkillPaths = Array.from(
    new Set([...managedSkillPaths, ...(options.additionalSkillPaths || [])]),
  );

  applyRuntimeProfileEnvironment({ agentDir });

  const initialSessionManager =
    options.sessionManager ||
    SessionManager.create(cwd, getRuntimeSessionDir(cwd, agentDir));
  applyStartupSessionName(initialSessionManager, options.sessionName);
  patchPiSessionManagerConversationPersistence(initialSessionManager);

  const createRuntime = async ({
    cwd: runtimeCwd,
    agentDir: runtimeAgentDir,
    sessionManager,
    sessionStartEvent,
  }: {
    cwd: string;
    agentDir: string;
    sessionManager: any;
    sessionStartEvent?: any;
  }) => {
    if (process.cwd() !== runtimeCwd) {
      process.chdir(runtimeCwd);
    }
    applyRuntimeProfileEnvironment({ agentDir: runtimeAgentDir });
    patchPiSessionManagerConversationPersistence(sessionManager);

    const settingsManager = SettingsManager.create(runtimeCwd, runtimeAgentDir);
    applyBundledRinExtensionAliases(settingsManager);

    const services = await createAgentSessionServices({
      cwd: runtimeCwd,
      agentDir: runtimeAgentDir,
      settingsManager,
      resourceLoaderOptions: {
        additionalExtensionPaths: options.additionalExtensionPaths ?? [],
        noExtensions: options.noExtensions,
        additionalSkillPaths,
        noSkills: options.noSkills,
        additionalPromptTemplatePaths:
          options.additionalPromptTemplatePaths ?? [],
        noPromptTemplates: options.noPromptTemplates,
        additionalThemePaths: options.additionalThemePaths ?? [],
        noThemes: options.noThemes,
        noContextFiles: options.noContextFiles,
        systemPrompt: options.systemPrompt,
        appendSystemPrompt: options.appendSystemPrompt,
      },
      extensionFlagValues: options.extensionFlagValues,
    });
    applyRinSettingsDefaults(services.settingsManager);

    let resolvedModel: any = undefined;
    const modelRef = String(options.modelRef || "").trim();
    if (modelRef) {
      const slash = modelRef.indexOf("/");
      if (slash <= 0 || slash >= modelRef.length - 1) {
        throw new Error(`invalid_model_ref:${modelRef}`);
      }
      const provider = modelRef.slice(0, slash);
      const modelId = modelRef.slice(slash + 1);
      resolvedModel = services.modelRegistry.find(provider, modelId);
      if (!resolvedModel) throw new Error(`unknown_model:${modelRef}`);
      if (!services.modelRegistry.hasConfiguredAuth(resolvedModel)) {
        throw new Error(`No API key for ${modelRef}`);
      }
    }

    const sessionRef: { current?: any } = {};
    const compactWithRinPrompt = async (event: any) => {
      const session = sessionRef.current;
      const preparation = event?.preparation;
      const model = session?.model;
      if (!session || !preparation || !model) return undefined;
      if (
        typeof convertToLlm !== "function" ||
        typeof serializeConversation !== "function"
      ) {
        return undefined;
      }

      const { apiKey, headers } = await getPiSessionCompactionRequestAuth(
        session,
        model,
      );
      const reserveTokens = Number(preparation?.settings?.reserveTokens || 0);
      const maxTokens = Math.min(
        Math.floor(0.8 * (reserveTokens || 16384)),
        model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
      );
      const serializeMessages = (messages: any[]) =>
        serializeConversation(convertToLlm(messages));

      const commonOptions = {
        model,
        maxTokens,
        apiKey,
        headers,
        signal: event?.signal,
        thinkingLevel: session.thinkingLevel,
        streamFn: session.agent?.streamFn,
        serializeMessages,
      };
      const providerTokensBefore = estimateCurrentProviderContextTokens(
        getSessionProviderContextMessages(session),
        { estimateContextTokens },
      );
      const messagesToSummarize = mapMessagesToCurrentProviderContext(
        preparation.messagesToSummarize || [],
        session,
      );
      const historySummary = await completeRinCompactionSummaryBudgeted({
        ...commonOptions,
        messages: messagesToSummarize,
        instruction: appendRinCompactionCustomInstructions(
          RIN_COMPACTION_PROMPT,
          event?.customInstructions,
        ),
        previousSummary: preparation.previousSummary,
      });
      let summary = historySummary || "No prior history.";
      if (preparation.isSplitTurn && preparation.turnPrefixMessages?.length) {
        const turnPrefixMessages = mapMessagesToCurrentProviderContext(
          preparation.turnPrefixMessages,
          session,
        );
        const turnPrefixSummary = await completeRinCompactionSummaryBudgeted({
          ...commonOptions,
          maxTokens: Math.min(Math.floor(maxTokens * 0.5), maxTokens),
          messages: turnPrefixMessages,
          instruction: RIN_TURN_PREFIX_COMPACTION_PROMPT,
        });
        summary = `${summary}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixSummary}`;
      }

      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: providerTokensBefore || preparation.tokensBefore,
        },
      };
    };
    const rinCapabilities = createRinCapabilitySet({
      cwd: runtimeCwd,
      agentDir: runtimeAgentDir,
      sessionManager,
      modelRegistry: services.modelRegistry,
      disabledNames: options.disabledRinCapabilities ?? [],
      definitions: createRinCapabilityDefinitions({
        cwd: runtimeCwd,
        agentDir: runtimeAgentDir,
        getThinkingLevel: () =>
          sessionRef.current?.thinkingLevel ||
          options.thinkingLevel ||
          "medium",
        sendMessage: (message, messageOptions) => {
          sessionRef.current
            ?.sendCustomMessage?.(message, messageOptions)
            .catch?.(() => {});
        },
        emitEvent: (event) => {
          sessionRef.current?.__rinEmitCoreEvent?.(event);
        },
        compactWithRinPrompt,
      }),
    });

    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model: resolvedModel,
      thinkingLevel: options.thinkingLevel,
      tools: options.tools,
      excludeTools: options.excludeTools,
      noTools: options.noTools,
      customTools: rinCapabilities.getToolDefinitions(),
    });
    sessionRef.current = result.session;
    if (sessionManager?.[EPHEMERAL_FORK_DISABLE_ROUTINE_COMPACTION_KEY]) {
      result.session[EPHEMERAL_FORK_DISABLE_ROUTINE_COMPACTION_KEY] = true;
    }

    applyRinCompactionReasonTracking(result.session);
    applyRinPrunedContextUsage(result.session, { estimateContextTokens });
    applyRinCompactionPercentThreshold(result.session, {
      calculateContextTokens,
      estimateContextTokens,
      getLatestCompactionEntry,
    });

    await attachRinCapabilitiesToSession(result.session, {
      capabilitySet: rinCapabilities,
      reason: String(sessionStartEvent?.reason || "startup") as
        | "startup"
        | "reload"
        | "new"
        | "resume"
        | "fork",
      previousSessionFile:
        String(sessionStartEvent?.previousSessionFile || "") || undefined,
    });
    applyRinProviderOverflowPreflight(result.session, {
      estimateContextTokens,
    });
    applyRinBackendToolExecutionLocks(result.session);

    applyRinPromptBuilder(result.session);
    applyAutoReloadAfterCompaction(result.session);
    return {
      ...result,
      services,
      diagnostics: services.diagnostics,
    };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: initialSessionManager.getCwd?.() || cwd,
    agentDir,
    sessionManager: initialSessionManager,
  });
  patchRinRuntimeSessionShutdown(runtime);

  return {
    session: runtime.session,
    runtime,
    extensionsResult: runtime.session.resourceLoader.getExtensions(),
    modelFallbackMessage: runtime.modelFallbackMessage,
  };
}
