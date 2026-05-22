import os from "node:os";
import path from "node:path";

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
import { formatPromptContextSystemPromptBlock } from "../chat-bridge/prompt-context.js";

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

function buildRinRuntimeAwarenessBlock() {
  return [
    "You are an LLM running inside an agent loop: one bounded turn from input or scheduled trigger to a single final response; after that, work stops until another loop starts.",
    "You are running in the Rin runtime environment.",
  ].join("\n");
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
    "- Scheduled task guidance: For reminders, follow-ups, periodic/conditional checks, recurring jobs, or work that should continue after this turn, use Rin scheduled tasks first. Read docs/agent-sdk.md and docs/scheduled-tasks.md before task operations.",
    "- Rich text guidance: when a response or chat send needs native mentions, quotes/replies, attachments, files/images, or explicit fallback text, read docs/rich-text-output-format.md and use Rin native rich output syntax instead of plain-text approximations.",
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
      const turnPrompt = appendPromptContextSystemPrompt(
        basePrompt,
        options?.promptContext,
      );
      if (turnPrompt === basePrompt) {
        return await originalPrompt(text, options);
      }
      const previousActiveTurnPrompt = session[ACTIVE_TURN_SYSTEM_PROMPT_KEY];
      const activeTurnPrompt: {
        basePrompt: string;
        turnPrompt: string;
        refreshedBasePrompt?: string;
      } = { basePrompt, turnPrompt };
      session[ACTIVE_TURN_SYSTEM_PROMPT_KEY] = activeTurnPrompt;
      applySessionBaseSystemPrompt(session, turnPrompt);
      try {
        return await originalPrompt(text, options);
      } finally {
        if (previousActiveTurnPrompt === undefined) {
          delete session[ACTIVE_TURN_SYSTEM_PROMPT_KEY];
        } else {
          session[ACTIVE_TURN_SYSTEM_PROMPT_KEY] = previousActiveTurnPrompt;
        }
        applySessionBaseSystemPrompt(
          session,
          String(activeTurnPrompt.refreshedBasePrompt || basePrompt),
        );
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
const COMPACTION_CONCURRENCY_GUARD_KEY = Symbol.for(
  "rin.compactionConcurrencyGuard",
);
const COMPACTION_SETTINGS_TUNING_KEY = Symbol.for(
  "rin.compactionSettingsTuning",
);

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

  const originalRunAutoCompaction =
    typeof session._runAutoCompaction === "function"
      ? session._runAutoCompaction.bind(session)
      : null;
  if (originalRunAutoCompaction) {
    session._runAutoCompaction = async function patchedRunAutoCompaction(
      reason: string,
      ...args: any[]
    ) {
      return await withReason(String(reason || "auto"), () =>
        originalRunAutoCompaction(reason, ...args),
      );
    };
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

function abortActiveCompaction(session: any) {
  try {
    session?.abortCompaction?.();
  } catch {}
}

type RinCompactionGuardState = {
  activeCompaction?: { reason: string; promise: Promise<unknown> };
};

function isRinCompactionBusy(session: any, state: RinCompactionGuardState) {
  return Boolean(state.activeCompaction || session?.isCompacting);
}

async function runRinCompactionExclusive<T>(
  session: any,
  state: RinCompactionGuardState,
  reason: string,
  onBusy: () => T | Promise<T>,
  run: () => T | Promise<T>,
): Promise<T> {
  if (isRinCompactionBusy(session, state)) return await onBusy();
  const promise = Promise.resolve(run());
  state.activeCompaction = { reason, promise };
  try {
    return await promise;
  } finally {
    if (state.activeCompaction?.promise === promise) {
      state.activeCompaction = undefined;
    }
  }
}

export function applyRinCompactionSettingsTuning(session: any) {
  if (!session || typeof session !== "object") return;
  if ((session as any)[COMPACTION_SETTINGS_TUNING_KEY]) return;
  const settingsManager = session.settingsManager;
  const original =
    typeof settingsManager?.getCompactionSettings === "function"
      ? settingsManager.getCompactionSettings.bind(settingsManager)
      : null;
  if (!original) return;

  settingsManager.getCompactionSettings = () => {
    const settings = { ...(original() || {}) };
    const contextWindow = Number(session.model?.contextWindow || 0);
    if (contextWindow >= 100_000) {
      settings.reserveTokens = Math.max(
        Number(settings.reserveTokens || 0),
        Math.min(32_768, Math.floor(contextWindow * 0.08)),
      );
      settings.keepRecentTokens = Math.max(
        Number(settings.keepRecentTokens || 0),
        Math.min(120_000, Math.floor(contextWindow * 0.35)),
      );
    }
    return settings;
  };

  (session as any)[COMPACTION_SETTINGS_TUNING_KEY] = { original };
}

export function applyRinCompactionConcurrencyGuard(session: any) {
  if (!session || typeof session !== "object") return;
  if ((session as any)[COMPACTION_CONCURRENCY_GUARD_KEY]) return;

  const guardState: RinCompactionGuardState = {};

  const originalCompact =
    typeof session.compact === "function"
      ? session.compact.bind(session)
      : null;
  if (originalCompact) {
    session.compact = async function guardedManualCompaction(...args: any[]) {
      return await runRinCompactionExclusive(
        session,
        guardState,
        "manual",
        () => {
          throw new Error("Compaction already in progress");
        },
        () => originalCompact(...args),
      );
    };
  }

  const originalRunAutoCompaction =
    typeof session._runAutoCompaction === "function"
      ? session._runAutoCompaction.bind(session)
      : null;
  if (originalRunAutoCompaction) {
    session._runAutoCompaction = async function guardedAutoCompaction(
      reason: string,
      ...args: any[]
    ) {
      return await runRinCompactionExclusive(
        session,
        guardState,
        String(reason || "auto"),
        () => undefined,
        () => originalRunAutoCompaction(reason, ...args),
      );
    };
  }

  const originalAbort =
    typeof session.abort === "function" ? session.abort.bind(session) : null;
  if (originalAbort) {
    session.abort = async (...args: any[]) => {
      if (isRinCompactionBusy(session, guardState))
        abortActiveCompaction(session);
      return await originalAbort(...args);
    };
  }

  (session as any)[COMPACTION_CONCURRENCY_GUARD_KEY] = {
    originalCompact,
    originalRunAutoCompaction,
    originalAbort,
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
      String(
        session?._baseSystemPrompt || session?.agent?.state?.systemPrompt || "",
      ),
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

  const originalRunAutoCompaction =
    typeof session._runAutoCompaction === "function"
      ? session._runAutoCompaction.bind(session)
      : null;
  if (originalRunAutoCompaction) {
    session._runAutoCompaction = async function patchedAutoReloadCompaction(
      ...args: any[]
    ) {
      compactionDepth += 1;
      try {
        return await originalRunAutoCompaction(...args);
      } finally {
        await finishCompactionReload();
      }
    };
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
  await session.__rinCapabilities.emit(event);
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
      typeof session._refreshToolRegistry === "function"
        ? session._refreshToolRegistry.bind(session)
        : null;
    if (originalRefreshToolRegistry) {
      session._refreshToolRegistry = (...args: any[]) => {
        const result = originalRefreshToolRegistry(...args);
        wrapActiveTools();
        return result;
      };
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
  const agentRuntimeModule = await loadRinAgentRuntime();
  const {
    createAgentSessionRuntime,
    createAgentSessionServices,
    createAgentSessionFromServices,
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
        emitEvent: (event) => {
          sessionRef.current?.__rinEmitCoreEvent?.(event);
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

    applyRinCompactionReasonTracking(result.session);

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
    applyRinBackendToolExecutionLocks(result.session);

    applyRinPromptBuilder(result.session);
    applyRinCompactionSettingsTuning(result.session);
    applyAutoReloadAfterCompaction(result.session);
    applyRinCompactionConcurrencyGuard(result.session);
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
