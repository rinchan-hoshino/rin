import os from "node:os";
import path from "node:path";

import { isContextOverflow } from "@mariozechner/pi-ai";

import { applyBundledRinExtensionAliases } from "../rin-bundled-extensions.js";
import { estimateContextTokens } from "../rin-tui/session-helpers.js";
import {
  buildConfiguredLanguageSystemPrompt,
  readConfiguredLanguageFromSettings,
} from "../language.js";
import { loadRinCodingAgent } from "./loader.js";
import {
  applyRuntimeProfileEnvironment,
  getRuntimeSessionDir,
  resolveRuntimeProfile,
  PI_AGENT_DIR_ENV,
  RIN_DIR_ENV,
} from "./profile.js";
import {
  clearCompactionContinuationMarker,
  consumeCompactionContinuationMarker,
  getCompactionContinuationMarkerPath,
  writeCompactionContinuationMarker,
} from "./compaction-continuation.js";
import memoryModule from "../memory/index.js";
import selfImproveModule from "../self-improve/index.js";
import taskModule from "../task/index.js";
import tokenUsageModule from "../token-usage/index.js";
import webSearchModule from "../rin-web-search/index.js";
import chatModule from "../chat/index.js";
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

const PROMPT_PREFIX = "As the assistant, you must fulfill the user's requests.";

const DEFAULT_PI_GUIDELINES = [
  "Be concise in your responses",
  "Show file paths clearly when working with files",
  "Do not stop after one action if the user's request obviously requires multiple concrete steps",
  "When modifying files, prefer targeted edits and preserve existing style unless asked otherwise",
  "When using bash, explain meaningful findings instead of pasting excessive raw output",
];

const RICH_CHAT_CONTENT_SYNTAX = [
  "Chat rich content Markdown syntax:",
  "- Native at: [@name](at:<platform-user-id>). Raw @name text is plain text only.",
  "- Quote reply: [quote:<message-id>] drives the platform reply/quote target.",
  "- Image/file/video/audio/sticker: [image: name](url), [file: name](url), [video: name](url), [audio: name](url), [sticker: name](url).",
  "- Unsupported rich objects degrade to readable plain text; supported rich objects are sent natively when possible.",
].join("\n");

export function createRinCapabilityDefinitions(
  options: RinCapabilityOptions,
): RinCapabilityDefinition[] {
  return [
    webSearchModule(),
    memoryModule(options),
    selfImproveModule(options),
    taskModule(),
    chatModule(),
    tokenUsageModule(options),
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
    "- Common Rin routes: scheduled tasks/reminders -> docs/scheduled-tasks.md; chat bridge -> docs/chat-bridge.md; non-interactive CLI -> docs/non-interactive-cli.md; runtime layout/update -> docs/runtime-layout.md and docs/capabilities.md.",
    "- For topics not covered by Rin docs, use Pi README.md and docs/ as the base reference. Rin docs override Pi docs where they differ.",
    `- Upstream Pi examples live at ${path.join(piRoot, "examples")}.`,
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
  const validToolNames = toolNames.filter((name) =>
    session._toolRegistry.has(name),
  );
  const toolSnippets: Record<string, string> = {};
  const promptGuidelines: string[] = [];
  for (const name of validToolNames) {
    const snippet = session._toolPromptSnippets.get(name);
    if (snippet) toolSnippets[name] = snippet;
    const toolGuidelineSet = session._toolPromptGuidelines.get(name);
    if (toolGuidelineSet) promptGuidelines.push(...toolGuidelineSet);
  }

  const promptAgentDir =
    session._resourceLoader.agentDir ||
    process.env.RIN_DIR ||
    process.env[PI_AGENT_DIR_ENV] ||
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
  const loaderSystemPrompt = session._resourceLoader.getSystemPrompt();
  const appendSystemPromptList =
    session._resourceLoader.getAppendSystemPrompt();
  const appendSystemPrompt =
    appendSystemPromptList.length > 0
      ? appendSystemPromptList.join("\n\n")
      : "";
  const loadedSkills = session._resourceLoader.getSkills().skills;
  const loadedContextFiles =
    session._resourceLoader.getAgentsFiles().agentsFiles;
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
      RICH_CHAT_CONTENT_SYNTAX,
      "",
      docsBlock,
      configuredLanguageBlock ? `\n${configuredLanguageBlock}` : "",
    ].join("\n");
  } else {
    prompt = [
      prompt,
      RICH_CHAT_CONTENT_SYNTAX,
      docsBlock,
      configuredLanguageBlock,
    ]
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
  return `${PROMPT_PREFIX}\n\n${prompt}`.trimEnd();
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
  if (!session || typeof session !== "object") return;
  const next = String(systemPrompt || "");
  session._baseSystemPrompt = next;
  if (session.agent?.state && typeof session.agent.state === "object") {
    session.agent.state.systemPrompt = next;
  }
  if (typeof session.agent?.setSystemPrompt === "function") {
    session.agent.setSystemPrompt(next);
  }
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

const COMPACTION_CONTINUATION_BLOCK = [
  "Context compacted; treat this as a routine internal checkpoint.",
  "Resume the current task immediately from its current state.",
  "Execute the next concrete step directly without narration.",
  "If work remains, keep doing it.",
].join("\n");

function appendCompactionContinuationBlock(systemPrompt: string) {
  const base = String(systemPrompt || "").trim();
  return base
    ? `${base}\n\n${COMPACTION_CONTINUATION_BLOCK}`
    : COMPACTION_CONTINUATION_BLOCK;
}

export function consumeCompactionContinuationSystemPrompt(
  session: any,
  systemPrompt: string,
) {
  const marker = consumeCompactionContinuationMarker(session);
  if (!marker) return systemPrompt;
  return appendCompactionContinuationBlock(systemPrompt);
}

export function ensureSessionBaseSystemPrompt(session: any): string {
  if (!session || typeof session !== "object") return "";
  const state = session[LAZY_SYSTEM_PROMPT_STATE_KEY] as
    | LazySystemPromptState
    | undefined;
  if (!state || typeof state.compute !== "function") {
    return String(
      session._baseSystemPrompt || session.agent?.state?.systemPrompt || "",
    );
  }
  if (state.materialized) {
    return String(
      session._baseSystemPrompt || session.agent?.state?.systemPrompt || "",
    );
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

function applyRinPromptBuilder(session: any) {
  if (!session || typeof session !== "object") return;
  const originalRebuild =
    typeof session._rebuildSystemPrompt === "function"
      ? session._rebuildSystemPrompt.bind(session)
      : null;
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

  session._rebuildSystemPrompt = () => {
    if (!state.materialized) return "";
    return String(session._baseSystemPrompt || "");
  };

  const originalPrompt =
    typeof session.prompt === "function" ? session.prompt.bind(session) : null;
  if (originalPrompt) {
    session.prompt = async (text: string, options?: any) => {
      const basePrompt = ensureSessionBaseSystemPrompt(session);
      const nextPrompt = consumeCompactionContinuationSystemPrompt(
        session,
        basePrompt,
      );
      if (nextPrompt === basePrompt) {
        return await originalPrompt(text, options);
      }
      applySessionBaseSystemPrompt(session, nextPrompt);
      try {
        return await originalPrompt(text, options);
      } finally {
        applySessionBaseSystemPrompt(session, basePrompt);
      }
    };
  }

  const originalReload =
    typeof session.reload === "function" ? session.reload.bind(session) : null;
  if (originalReload) {
    session.reload = async (...args: any[]) => {
      clearSessionBaseSystemPrompt(session, { ignorePersistedPrompt: true });
      return await originalReload(...args);
    };
  }

  clearSessionBaseSystemPrompt(session);
}

const AUTO_RELOAD_AFTER_COMPACTION_KEY = Symbol.for(
  "rin.autoReloadAfterCompaction",
);
const OVERFLOW_CONTINUATION_PROMPT_KEY = Symbol.for(
  "rin.overflowContinuationPrompt",
);
const MID_TURN_COMPACTION_KEY = Symbol.for("rin.midTurnCompaction");
const DISABLE_END_TURN_THRESHOLD_KEY = Symbol.for(
  "rin.disableEndTurnThresholdCompaction",
);
const RETRYABLE_PROVIDER_ERRORS_KEY = Symbol.for("rin.retryableProviderErrors");
const DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT = 50;
const MID_TURN_CONTINUATION_BLOCK = COMPACTION_CONTINUATION_BLOCK;

function mutateMessageArray(target: any[], source: any[]) {
  if (!Array.isArray(target)) return;
  target.length = 0;
  for (const item of Array.isArray(source) ? source : []) target.push(item);
}

export function isRinContextOverflow(message: any, contextWindow?: number) {
  if (isContextOverflow(message, contextWindow)) return true;
  if (message?.stopReason !== "error") return false;
  const errorMessage = String(message?.errorMessage || "");
  return /\bWebSocket closed\s+1009\b/i.test(errorMessage);
}

export function isRinRetryableProviderError(message: any) {
  if (message?.stopReason !== "error") return false;
  const errorMessage = String(message?.errorMessage || "");
  if (/\bWebSocket closed\s+1009\b/i.test(errorMessage)) return false;
  return /\bWebSocket (?:error|closed)\b/i.test(errorMessage);
}

function buildMidTurnLlmContext(
  session: any,
  systemPrompt: string,
  tools: any[],
) {
  const rawMessages = Array.isArray(session?.agent?.state?.messages)
    ? session.agent.state.messages
    : [];
  const converted = session?.agent?.convertToLlm
    ? session.agent.convertToLlm(rawMessages)
    : rawMessages;
  return Promise.resolve(converted).then((messages: any[]) => ({
    systemPrompt: systemPrompt
      ? `${systemPrompt}\n\n${MID_TURN_CONTINUATION_BLOCK}`
      : MID_TURN_CONTINUATION_BLOCK,
    messages,
    tools,
  }));
}

export function applyOverflowContinuationPrompt(session: any) {
  if (!session || typeof session !== "object") return;
  if ((session as any)[OVERFLOW_CONTINUATION_PROMPT_KEY]) return;
  if (typeof session.subscribe !== "function") return;

  const unsubscribe = session.subscribe((event: any) => {
    if (event?.type !== "compaction_end") return;
    if (event?.aborted || !event?.result) return;
    if (String(event?.reason || "").trim() !== "overflow") return;
    writeCompactionContinuationMarker(session, {
      reason: "overflow",
    });
  });

  (session as any)[OVERFLOW_CONTINUATION_PROMPT_KEY] = { unsubscribe };
}

export function applyDisableEndTurnThresholdCompaction(session: any) {
  if (!session || typeof session !== "object") return;
  if ((session as any)[DISABLE_END_TURN_THRESHOLD_KEY]) return;
  const original =
    typeof session._checkCompaction === "function"
      ? session._checkCompaction.bind(session)
      : null;
  if (!original) return;

  session._checkCompaction = async function patchedCheckCompaction(
    assistantMessage: any,
    skipAbortedCheck = true,
  ) {
    const contextWindow = Number(session.model?.contextWindow || 0);
    if (!isRinContextOverflow(assistantMessage, contextWindow)) {
      return;
    }

    if (isContextOverflow(assistantMessage, contextWindow)) {
      return await original(assistantMessage, skipAbortedCheck);
    }

    if (session._overflowRecoveryAttempted) {
      session._emit?.({
        type: "compaction_end",
        reason: "overflow",
        result: undefined,
        aborted: false,
        willRetry: false,
        errorMessage:
          "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
      });
      return;
    }

    session._overflowRecoveryAttempted = true;
    const messages = session.agent?.state?.messages;
    if (
      Array.isArray(messages) &&
      messages.length > 0 &&
      messages[messages.length - 1]?.role === "assistant"
    ) {
      session.agent.state.messages = messages.slice(0, -1);
    }
    await session._runAutoCompaction?.("overflow", true);
  };

  (session as any)[DISABLE_END_TURN_THRESHOLD_KEY] = { original };
}

export function applyRinRetryableProviderErrors(session: any) {
  if (!session || typeof session !== "object") return;
  if ((session as any)[RETRYABLE_PROVIDER_ERRORS_KEY]) return;
  const original =
    typeof session._isRetryableError === "function"
      ? session._isRetryableError.bind(session)
      : null;
  if (!original) return;

  session._isRetryableError = function patchedIsRetryableError(message: any) {
    return original(message) || isRinRetryableProviderError(message);
  };

  (session as any)[RETRYABLE_PROVIDER_ERRORS_KEY] = { original };
}

export function applyMidTurnCompaction(
  session: any,
  thresholdPercent = DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT,
) {
  if (!session || typeof session !== "object") return;
  if ((session as any)[MID_TURN_COMPACTION_KEY]) return;
  const agent = session.agent;
  if (!agent || typeof agent.streamFn !== "function") return;

  const originalStreamFn = agent.streamFn.bind(agent);
  const originalTransformContext =
    typeof agent.transformContext === "function"
      ? agent.transformContext.bind(agent)
      : null;

  let inPreflight = false;
  let injectCueForCurrentCall = false;

  agent.transformContext = async (messages: any[], signal?: AbortSignal) => {
    const transformed = originalTransformContext
      ? await originalTransformContext(messages, signal)
      : messages;

    if (inPreflight) return transformed;
    if (session?.[EPHEMERAL_FORK_DISABLE_ROUTINE_COMPACTION_KEY]) {
      return transformed;
    }
    if (session?.autoCompactionEnabled === false) return transformed;
    const contextWindow = Number(session.model?.contextWindow || 0);
    if (contextWindow <= 0) return transformed;

    const usageTokens = estimateContextTokens(
      Array.isArray(transformed) ? transformed : [],
    );
    const usagePercent = (usageTokens / contextWindow) * 100;
    if (usagePercent < thresholdPercent) return transformed;

    inPreflight = true;
    try {
      await session._runAutoCompaction?.("threshold", false);
      const compactedMessages = Array.isArray(session?.agent?.state?.messages)
        ? session.agent.state.messages
        : transformed;
      mutateMessageArray(messages, compactedMessages);
      injectCueForCurrentCall = true;
      return compactedMessages;
    } finally {
      inPreflight = false;
    }
  };

  agent.streamFn = async (model: any, context: any, options: any) => {
    if (!injectCueForCurrentCall) {
      return await originalStreamFn(model, context, options);
    }
    injectCueForCurrentCall = false;
    const nextContext = await buildMidTurnLlmContext(
      session,
      String(context?.systemPrompt || ""),
      context?.tools,
    );
    return await originalStreamFn(model, nextContext, options);
  };

  (session as any)[MID_TURN_COMPACTION_KEY] = {
    thresholdPercent,
    originalStreamFn,
    originalTransformContext,
  };
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

  const unsubscribe = session.subscribe((event: any) => {
    if (event?.type !== "compaction_end") return;
    if (event?.aborted || !event?.result) return;
    setTimeout(() => {
      void runReload();
    }, 0);
  });

  (session as any)[AUTO_RELOAD_AFTER_COMPACTION_KEY] = { unsubscribe };
}

export {
  clearCompactionContinuationMarker,
  consumeCompactionContinuationMarker,
  getCompactionContinuationMarkerPath,
  writeCompactionContinuationMarker,
};

export {
  applyRuntimeProfileEnvironment,
  getRuntimeSessionDir,
  resolveRuntimeProfile,
  PI_AGENT_DIR_ENV,
  RIN_DIR_ENV,
};

function normalizeQueueMode(value: unknown, fallback: "all" | "one-at-a-time") {
  return value === "all" || value === "one-at-a-time" ? value : fallback;
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

export async function createConfiguredAgentSession(
  options: {
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
    modelRef?: string;
    thinkingLevel?: any;
  } = {},
) {
  const codingAgentModule = await loadRinCodingAgent();
  const {
    createAgentSessionRuntime,
    createAgentSessionServices,
    createAgentSessionFromServices,
    SettingsManager,
    SessionManager,
  } = codingAgentModule as any;

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
      }),
    });

    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model: resolvedModel,
      thinkingLevel: options.thinkingLevel,
      customTools: rinCapabilities.getToolDefinitions(),
    });
    sessionRef.current = result.session;
    if (sessionManager?.[EPHEMERAL_FORK_DISABLE_ROUTINE_COMPACTION_KEY]) {
      result.session[EPHEMERAL_FORK_DISABLE_ROUTINE_COMPACTION_KEY] = true;
    }

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
    clearCompactionContinuationMarker(result.session);

    applyRinPromptBuilder(result.session);
    applyDisableEndTurnThresholdCompaction(result.session);
    applyRinRetryableProviderErrors(result.session);
    applyMidTurnCompaction(result.session);
    applyOverflowContinuationPrompt(result.session);
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

  return {
    session: runtime.session,
    runtime,
    extensionsResult: runtime.session.resourceLoader.getExtensions(),
    modelFallbackMessage: runtime.modelFallbackMessage,
  };
}
