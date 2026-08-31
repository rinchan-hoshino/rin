import os from "node:os";
import path from "node:path";

import { isContextOverflow } from "@earendil-works/pi-ai/compat";

import todoCapability from "./todo.js";
import { loadRinAgentRuntime } from "./agent-runtime.js";
import {
  applyRuntimeProfileEnvironment,
  getRuntimeSessionDir,
  resolveRuntimeProfile,
  RIN_DIR_ENV,
} from "./profile.js";
import memoryModule from "../memory/index.js";
import selfImproveModule from "../self-improve/index.js";
import chatModule from "../chat/index.js";
import { normalizeFrontendIdentity } from "../rin-lib/frontend-identity.js";
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
import {
  formatPromptContext,
  formatPromptContextSystemPromptBlock,
} from "../rin-lib/prompt-context.js";
import type { RinToolStartupOptions } from "./tool-options.js";
import type { RinPiPassthroughOptions } from "./pi-passthrough.js";
import {
  buildProviderBoundCompactionEvent,
  buildProviderBoundContextEvent,
  estimateProviderBoundContextTokens,
} from "./provider-context.js";
import {
  pruneSessionContextMessages,
  RIN_SESSION_PRUNING_RETAINED_TOOL_CALL_BUCKETS,
} from "./session-pruning.js";
import {
  buildRinSystemPrompt,
  readPiPublicSystemPromptOptions,
  type RinSystemPromptOptions,
} from "./system-prompt-overlay.js";
import {
  bindPiSessionAutoCompactor,
  bindPiSessionCompactionChecker,
  bindPiSessionSystemPromptRebuilder,
  bindPiSessionToolRegistryRefresher,
  installPiSessionCompactionOwner,
  patchPiSessionManagerConversationPersistence,
  replacePiSessionAutoCompactor,
  replacePiSessionCompactionChecker,
  replacePiSessionSystemPromptRebuilder,
  replacePiSessionToolRegistryRefresher,
  restorePiSessionActiveToolsForReload,
  runPiNativeCompactionWithoutFileSummary,
  runPiSessionAutoCompaction,
  writePiSessionBaseSystemPrompt,
} from "../pi/session-host.js";
import { shouldTriggerRinCompaction } from "../pi/compaction-policy.js";

export function createRinCapabilityDefinitions(
  options: RinCapabilityOptions,
): RinCapabilityDefinition[] {
  return [
    todoCapability(),
    memoryModule(options),
    selfImproveModule(options),
    chatModule(),
    {
      name: "rin_provider_bound_context",
      hooks: {
        context: [
          (event: any, ctx: any) => {
            if (!Array.isArray(event?.messages)) return undefined;
            return buildProviderBoundContextEvent(event, {
              cwd: String(ctx?.cwd || options.cwd || process.cwd()),
            });
          },
        ],
      },
    },
  ];
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

const LAZY_SYSTEM_PROMPT_STATE_KEY = Symbol.for("rin.lazySystemPromptState");
const SESSION_SYSTEM_PROMPT_ENTRY_TYPE = "rin-system-prompt-state";
const LEGACY_SESSION_SYSTEM_PROMPT_BLOCKS_ENTRY_TYPE =
  "rin-system-prompt-blocks";
const LEGACY_CONFIGURED_LANGUAGE_PROMPT_PATTERN =
  /^Configured runtime defaults:\n- Preferred language: ([^\r\n]+)\n- Unless the user explicitly asks otherwise, default to this language for replies, onboarding, and other user-facing text\.$/gm;
const LEGACY_LANGUAGE_ONLY_DEFAULTS: Record<string, string> = {
  ar: "ar_SA",
  de: "de_DE",
  en: "en_US",
  es: "es_ES",
  fr: "fr_FR",
  hi: "hi_IN",
  ja: "ja_JP",
  ko: "ko_KR",
  pt: "pt_BR",
  ru: "ru_RU",
  zh: "zh_CN",
};

const RETIRED_NOTE_PROMPT_CONTRACTS = [
  {
    tool: "- note: Read or mutate the current session-branch scratch note.",
    guideline:
      "- Use note for model-only scratch work that should survive compaction within the current session, not for user-facing output or cross-session memory.",
  },
  {
    tool: "- note: Read all continuity items or add, edit, and remove verified facts by stable ID.",
    guideline:
      "- Use note only for concise, verified facts that must survive compaction; keep plans, pending actions, and checklists in todo.",
  },
  {
    tool: "- note: Read or minimally update exact cross-compaction scratchpad items by stable ID.",
    guideline:
      "- Use note as a minimal scratchpad for verified content that must survive compaction exactly. Keep each item as short as possible and focused on exact cross-compaction state; rely on files or tools for recoverable context, and todo for plans, pending actions, and checklists. Clean up notes promptly as work advances.",
  },
  {
    tool: "- note: Session-branch scratchpad for exact cross-compaction state.",
    guideline:
      "- Use note for verified state that must survive compaction; use todo for execution checklists.",
  },
] as const;

function hasRetiredNotePromptContract(prompt: string) {
  const availableToolsAt = prompt.indexOf("Available tools:\n");
  const guidelinesAt = prompt.indexOf("\nGuidelines:\n", availableToolsAt);
  if (availableToolsAt < 0 || guidelinesAt < 0) return false;
  const toolLines = prompt.slice(availableToolsAt, guidelinesAt).split("\n");
  const guidelineLines = prompt.slice(guidelinesAt).split("\n");
  return RETIRED_NOTE_PROMPT_CONTRACTS.some(
    ({ tool, guideline }) =>
      toolLines.includes(tool) && guidelineLines.includes(guideline),
  );
}

type LazySystemPromptState = {
  materialized: boolean;
  systemPrompt: string;
  ignorePersistedPrompt: boolean;
  promptContext?: unknown;
  agentDir: string;
};

function isLegacyGeneratedLanguageTag(value: string) {
  const languageTag = String(value || "");
  if (!/^[A-Za-z]{2,8}(?:_[A-Za-z0-9]+)*$/.test(languageTag)) return false;
  try {
    const canonical =
      Intl.getCanonicalLocales(languageTag.replace(/_/g, "-"))[0] || "";
    const localeCode = canonical.replace(/-/g, "_");
    return (
      (LEGACY_LANGUAGE_ONLY_DEFAULTS[canonical.toLowerCase()] || localeCode) ===
      languageTag
    );
  } catch {
    return false;
  }
}

function isInsideMarkdownFence(prompt: string, offset: number) {
  let activeFence = "";
  let activeFenceLength = 0;
  for (const line of prompt.slice(0, offset).split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const marker = match[1] || "";
    const markerCharacter = marker[0] || "";
    if (!activeFence) {
      activeFence = markerCharacter;
      activeFenceLength = marker.length;
      continue;
    }
    if (
      markerCharacter === activeFence &&
      marker.length >= activeFenceLength &&
      !(match[2] || "").trim()
    ) {
      activeFence = "";
      activeFenceLength = 0;
    }
  }
  return Boolean(activeFence);
}

function historicalPromptLineValue(line: string | undefined, label: string) {
  return line?.startsWith(label)
    ? line.slice(label.length).replace(/\\/g, "/")
    : "";
}

function historicalReadmeRoot(value: string, docsDirectory: string) {
  const suffix = `${docsDirectory}/README.md`;
  const directoryAt = value.length - suffix.length;
  return value.endsWith(suffix) &&
    (directoryAt === 0 || value[directoryAt - 1] === "/")
    ? value.slice(0, -"/README.md".length)
    : "";
}

function historicalJoinedRoot(value: string, docsDirectory: string) {
  const separator = `${docsDirectory}/README.md and `;
  let separatorAt = value.indexOf(separator);
  while (separatorAt >= 0) {
    const hasDirectoryBoundary =
      separatorAt === 0 || value[separatorAt - 1] === "/";
    const root = value.slice(0, separatorAt + docsDirectory.length);
    if (
      hasDirectoryBoundary &&
      value === `${root}/README.md and ${root}/docs`
    ) {
      return root;
    }
    separatorAt = value.indexOf(separator, separatorAt + 1);
  }
  return "";
}

function historicalAgentRoot(docsRoot: string, docsDirectory: string) {
  return docsRoot.endsWith(docsDirectory)
    ? docsRoot.slice(0, -docsDirectory.length)
    : "";
}

const HISTORICAL_DOC_PATH_LABELS = [
  "- Main Rin documentation: ",
  "- Additional Rin docs: ",
  "- Main Pi documentation: ",
  "- Additional Pi docs: ",
  "- Rin docs: ",
  "- Pi base docs: ",
] as const;

function hasExpectedHistoricalPathLabels(
  lines: string[],
  expected: readonly string[],
) {
  return HISTORICAL_DOC_PATH_LABELS.every(
    (label) =>
      lines.filter((line) => line.startsWith(label)).length ===
      (expected.includes(label) ? 1 : 0),
  );
}

function hasHistoricalRinDocumentationPaths(lines: string[]) {
  const legacyLabels = HISTORICAL_DOC_PATH_LABELS.slice(0, 4);
  const mainRin = historicalPromptLineValue(lines[1], legacyLabels[0]);
  const additionalRin = historicalPromptLineValue(lines[2], legacyLabels[1]);
  const mainPi = historicalPromptLineValue(lines[3], legacyLabels[2]);
  const additionalPi = historicalPromptLineValue(lines[4], legacyLabels[3]);
  const mainRinRoot = historicalReadmeRoot(mainRin, "docs/rin");
  const mainPiRoot = historicalReadmeRoot(mainPi, "docs/pi");
  const legacyPaths =
    hasExpectedHistoricalPathLabels(lines, legacyLabels) &&
    Boolean(mainRinRoot && mainPiRoot) &&
    historicalAgentRoot(mainRinRoot, "docs/rin") ===
      historicalAgentRoot(mainPiRoot, "docs/pi") &&
    additionalRin === `${mainRinRoot}/docs` &&
    additionalPi === `${mainPiRoot}/docs`;

  const joinedLabels = HISTORICAL_DOC_PATH_LABELS.slice(4);
  const joinedRinRoot = historicalJoinedRoot(
    historicalPromptLineValue(lines[1], joinedLabels[0]),
    "docs/rin",
  );
  const joinedPiRoot = historicalJoinedRoot(
    historicalPromptLineValue(lines[2], joinedLabels[1]),
    "docs/pi",
  );
  const joinedPaths =
    hasExpectedHistoricalPathLabels(lines, joinedLabels) &&
    Boolean(joinedRinRoot && joinedPiRoot) &&
    historicalAgentRoot(joinedRinRoot, "docs/rin") ===
      historicalAgentRoot(joinedPiRoot, "docs/pi");
  return legacyPaths || joinedPaths;
}

function followsRinDocumentationBlock(prompt: string, offset: number) {
  if (prompt.slice(Math.max(0, offset - 2), offset) !== "\n\n") {
    return false;
  }
  const docsEnd = offset - 2;
  const previousSeparator = prompt.lastIndexOf("\n\n", docsEnd - 1);
  const docsStart = previousSeparator < 0 ? 0 : previousSeparator + 2;
  const lines = prompt.slice(docsStart, docsEnd).split("\n");
  return (
    lines[0] === "Rin and Pi documentation:" &&
    lines.length > 1 &&
    lines.slice(1).every((line) => line.startsWith("- ")) &&
    hasHistoricalRinDocumentationPaths(lines)
  );
}

function hasLegacyPromptLayerBoundary(
  prompt: string,
  offset: number,
  blockLength: number,
) {
  const trailing = prompt.slice(offset + blockLength);
  return (
    !trailing ||
    trailing.startsWith("\n\n") ||
    /^\nCurrent date: \d{4}-\d{2}-\d{2}(?:\n|$)/.test(trailing)
  );
}

function stripLegacyConfiguredLanguagePrompt(prompt: string) {
  const storedPrompt = String(prompt || "");
  const generatedBlocks: Array<{ offset: number; length: number }> = [];
  for (const match of storedPrompt.matchAll(
    LEGACY_CONFIGURED_LANGUAGE_PROMPT_PATTERN,
  )) {
    const block = match[0] || "";
    const languageTag = match[1] || "";
    const offset = match.index;
    if (
      !isLegacyGeneratedLanguageTag(languageTag) ||
      !followsRinDocumentationBlock(storedPrompt, offset) ||
      !hasLegacyPromptLayerBoundary(storedPrompt, offset, block.length) ||
      isInsideMarkdownFence(storedPrompt, offset)
    ) {
      continue;
    }
    generatedBlocks.push({ offset, length: block.length });
  }
  if (generatedBlocks.length !== 1) return storedPrompt;
  const [generatedBlock] = generatedBlocks;
  return (
    storedPrompt.slice(0, generatedBlock.offset) +
    storedPrompt.slice(generatedBlock.offset + generatedBlock.length)
  );
}

type PersistedSessionSystemPrompt = {
  prompt: string;
  entryIndex: number;
};

function findPersistedSessionBaseSystemPromptEntry(entries: any[]) {
  if (!Array.isArray(entries)) return null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type !== "custom" ||
      String(entry?.customType || "") !== SESSION_SYSTEM_PROMPT_ENTRY_TYPE
    ) {
      continue;
    }
    const storedPrompt = String(entry?.data?.systemPrompt || "");
    if (!storedPrompt.trim()) continue;
    const prompt = stripLegacyConfiguredLanguagePrompt(storedPrompt);
    if (hasRetiredNotePromptContract(prompt)) return null;
    return {
      prompt,
      entryIndex: index,
    } satisfies PersistedSessionSystemPrompt;
  }
  return null;
}

function findPersistedSessionBaseSystemPrompt(entries: any[]) {
  return findPersistedSessionBaseSystemPromptEntry(entries)?.prompt || "";
}

function normalizeLegacySystemPromptBlocks(rows: unknown[]) {
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const block = String(row || "").trim();
    if (!block || seen.has(block)) continue;
    seen.add(block);
    blocks.push(block);
  }
  return blocks;
}

function readUnsealedLegacySystemPromptBlocks(
  entries: any[],
  basePromptEntryIndex: number,
) {
  for (
    let index = entries.length - 1;
    index > basePromptEntryIndex;
    index -= 1
  ) {
    const entry = entries[index];
    if (
      entry?.type !== "custom" ||
      String(entry?.customType || "") !==
        LEGACY_SESSION_SYSTEM_PROMPT_BLOCKS_ENTRY_TYPE ||
      !Array.isArray(entry?.data?.blocks)
    ) {
      continue;
    }
    return normalizeLegacySystemPromptBlocks(entry.data.blocks);
  }
  return [];
}

function appendSystemPromptBlocks(prompt: string, blocks: string[]) {
  let next = String(prompt || "");
  for (const block of blocks) {
    const normalized = String(block || "").trim();
    if (!normalized || next.includes(normalized)) continue;
    next = `${next}\n\n${normalized}`;
  }
  return next;
}

function readPersistedSessionBaseSystemPrompt(sessionManager: any) {
  const entries = sessionManager?.getBranch?.();
  const persisted = findPersistedSessionBaseSystemPromptEntry(entries);
  if (!persisted) return { prompt: "", needsLegacySeal: false };
  const legacyBlocks = readUnsealedLegacySystemPromptBlocks(
    entries,
    persisted.entryIndex,
  );
  return {
    prompt: appendSystemPromptBlocks(persisted.prompt, legacyBlocks),
    needsLegacySeal: legacyBlocks.length > 0,
  };
}

function persistSessionBaseSystemPrompt(
  sessionManager: any,
  systemPrompt: string,
) {
  const prompt = String(systemPrompt || "");
  if (!prompt.trim()) return;
  if (typeof sessionManager?.appendCustomEntry !== "function") return;
  const current = findPersistedSessionBaseSystemPrompt(
    sessionManager.getBranch?.(),
  );
  if (current === prompt) return;
  sessionManager.appendCustomEntry(SESSION_SYSTEM_PROMPT_ENTRY_TYPE, {
    version: 1,
    systemPrompt: prompt,
  });
}

function buildOptionalSelfImprovePromptBlock(agentDir: string) {
  try {
    return buildSelfImprovePromptBlock(agentDir);
  } catch {
    return "";
  }
}

function materializeRinSystemPrompt(
  state: LazySystemPromptState,
  sessionManager: any,
  piOptions: RinSystemPromptOptions,
  initialPromptContext?: unknown,
) {
  if (state.materialized) return state.systemPrompt;
  if (!state.ignorePersistedPrompt) {
    const persisted = readPersistedSessionBaseSystemPrompt(sessionManager);
    if (persisted.prompt) {
      state.materialized = true;
      state.systemPrompt = persisted.prompt;
      if (persisted.needsLegacySeal) {
        persistSessionBaseSystemPrompt(sessionManager, persisted.prompt);
      }
      return persisted.prompt;
    }
  }
  const next = appendPromptContextSystemPrompt(
    buildRinSystemPrompt({
      piOptions,
      agentDir: state.agentDir,
      selfImprovePromptBlock: buildOptionalSelfImprovePromptBlock(
        state.agentDir,
      ),
    }),
    initialPromptContext,
  );
  state.materialized = true;
  state.systemPrompt = next;
  state.ignorePersistedPrompt = false;
  persistSessionBaseSystemPrompt(sessionManager, next);
  return next;
}

export function clearSessionBaseSystemPrompt(
  session: any,
  options: { ignorePersistedPrompt?: boolean } = {},
) {
  if (!session || typeof session !== "object") return;
  const state = session[LAZY_SYSTEM_PROMPT_STATE_KEY] as
    | LazySystemPromptState
    | undefined;
  if (!state) return;
  state.materialized = false;
  state.systemPrompt = "";
  if (options.ignorePersistedPrompt) {
    state.ignorePersistedPrompt = true;
  }
  writePiSessionBaseSystemPrompt(session, "");
}

export function ensureSessionBaseSystemPrompt(
  session: any,
  initialPromptContext?: unknown,
): string {
  if (!session || typeof session !== "object") return "";
  const state = session[LAZY_SYSTEM_PROMPT_STATE_KEY] as
    | LazySystemPromptState
    | undefined;
  if (!state) return String(session.systemPrompt || "");
  if (initialPromptContext !== undefined) {
    state.promptContext = initialPromptContext;
  }
  const prompt = materializeRinSystemPrompt(
    state,
    session.sessionManager,
    readPiPublicSystemPromptOptions(session),
    state.promptContext,
  );
  writePiSessionBaseSystemPrompt(session, prompt);
  return prompt;
}

export function appendPromptContextSystemPrompt(
  systemPrompt: string,
  promptContext: unknown,
) {
  const block = formatPromptContextSystemPromptBlock(promptContext as any);
  if (!block.trim()) return String(systemPrompt || "");
  const base = String(systemPrompt || "").trimEnd();
  if (base.includes(block.trim())) return base;
  return base ? `${base}\n\n${block}` : block;
}

function applyRinPromptBuilder(session: any, state: LazySystemPromptState) {
  if (!session || typeof session !== "object") return;
  const originalRebuild = bindPiSessionSystemPromptRebuilder(session);
  if (!originalRebuild) throw new Error("rin_system_prompt_owner_unavailable");
  session[LAZY_SYSTEM_PROMPT_STATE_KEY] = state;
  replacePiSessionSystemPromptRebuilder(session, (toolNames: string[] = []) => {
    const piPrompt = originalRebuild(Array.isArray(toolNames) ? toolNames : []);
    return state.materialized ? state.systemPrompt : piPrompt;
  });

  const originalPrompt =
    typeof session.prompt === "function" ? session.prompt.bind(session) : null;
  if (originalPrompt) {
    session.prompt = async (text: string, options?: any) => {
      ensureSessionBaseSystemPrompt(session, options?.promptContext);
      const frontendIdentity = normalizeFrontendIdentity(
        options?.frontendIdentity,
      );
      const callerPreflightResult = options?.preflightResult;
      const manager = session.sessionManager;
      const previousFrontendIdentity = manager?.__rinFrontend;
      const restoreFrontendIdentity = () => {
        if (!manager) return;
        if (previousFrontendIdentity) {
          manager.__rinFrontend = previousFrontendIdentity;
        } else {
          delete manager.__rinFrontend;
        }
      };
      if (manager) {
        if (frontendIdentity) {
          manager.__rinFrontend = frontendIdentity;
        } else {
          delete manager.__rinFrontend;
        }
      }
      let preflightReported = false;
      const promptOptions = {
        ...(options || {}),
        preflightResult(accepted: boolean) {
          preflightReported = true;
          if (accepted && manager) {
            manager.__rinLastPromptSource = String(
              options?.source || "",
            ).trim();
            manager.__rinLastPromptContext = options?.promptContext;
          } else if (!accepted) {
            restoreFrontendIdentity();
          }
          callerPreflightResult?.(accepted);
        },
      };
      try {
        return await originalPrompt(
          formatPromptContext(options?.promptContext, text),
          promptOptions,
        );
      } finally {
        if (!preflightReported) restoreFrontendIdentity();
      }
    };
  }

  const originalReload =
    typeof session.reload === "function" ? session.reload.bind(session) : null;
  if (originalReload) {
    session.reload = async (...args: any[]) => {
      const reloadPromptContext =
        session.sessionManager?.__rinLastPromptContext;
      clearSessionBaseSystemPrompt(session, { ignorePersistedPrompt: true });
      const result = await originalReload(...args);
      restorePiSessionActiveToolsForReload(session);
      ensureSessionBaseSystemPrompt(session, reloadPromptContext);
      return result;
    };
  }

  clearSessionBaseSystemPrompt(session);
}

const AUTO_RELOAD_AFTER_COMPACTION_KEY = Symbol.for(
  "rin.autoReloadAfterCompaction",
);
const COMPACTION_PERCENT_THRESHOLD_KEY = Symbol.for(
  "rin.compactionPercentThreshold",
);
const PROVIDER_OVERFLOW_PREFLIGHT_KEY = Symbol.for(
  "rin.providerOverflowPreflight",
);
const PRESSURE_RETAINED_TOOL_CALL_BUCKETS_KEY = Symbol.for(
  "rin.pressureRetainedToolCallBuckets",
);
const PRESSURE_PRUNING_GENERATION_KEY = Symbol.for(
  "rin.pressurePruningGeneration",
);
const MID_TURN_THRESHOLD_COMPACTION_KEY = Symbol.for(
  "rin.midTurnThresholdCompaction",
);

export function getRinPressureRetainedToolCallBuckets(session: any) {
  const value = Number(session?.[PRESSURE_RETAINED_TOOL_CALL_BUCKETS_KEY]);
  if (!Number.isFinite(value)) {
    return RIN_SESSION_PRUNING_RETAINED_TOOL_CALL_BUCKETS;
  }
  return Math.max(
    1,
    Math.min(RIN_SESSION_PRUNING_RETAINED_TOOL_CALL_BUCKETS, Math.floor(value)),
  );
}

function setRinPressureRetainedToolCallBuckets(session: any, value: number) {
  if (!session || typeof session !== "object") return;
  const nextValue = Math.max(
    1,
    Math.min(RIN_SESSION_PRUNING_RETAINED_TOOL_CALL_BUCKETS, Math.floor(value)),
  );
  if (getRinPressureRetainedToolCallBuckets(session) === nextValue) return;
  session[PRESSURE_RETAINED_TOOL_CALL_BUCKETS_KEY] = nextValue;
  session[PRESSURE_PRUNING_GENERATION_KEY] =
    Number(session[PRESSURE_PRUNING_GENERATION_KEY] || 0) + 1;
}

function getRinPressurePruningGeneration(session: any) {
  const value = Number(session?.[PRESSURE_PRUNING_GENERATION_KEY] || 0);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function resetRinPressureRetainedToolCallBuckets(session: any) {
  setRinPressureRetainedToolCallBuckets(
    session,
    RIN_SESSION_PRUNING_RETAINED_TOOL_CALL_BUCKETS,
  );
}

function rinPressurePruningOptions(session: any) {
  return {
    cwd: String(session?.sessionManager?.getCwd?.() || process.cwd()),
    retainedToolCallBuckets: getRinPressureRetainedToolCallBuckets(session),
  };
}

function withoutAssistantUsage(messages: any[]) {
  return (messages || []).map((message: any) => {
    if (message?.role !== "assistant" || !("usage" in message)) return message;
    const { usage: _usage, ...withoutUsage } = message;
    return withoutUsage;
  });
}

function buildRinPressureContextMessages(messages: any[], options?: any) {
  const sourceMessages = messages || [];
  const event = buildProviderBoundContextEvent(
    { type: "context", messages: sourceMessages },
    options,
  );
  return Array.isArray(event?.messages) ? event.messages : sourceMessages;
}

function estimateCurrentProviderContextTokens(
  messages: any[],
  helpers: { estimateContextTokens?: (messages: any[]) => any } = {},
  session?: any,
) {
  return estimateProviderBoundContextTokens(
    buildRinPressureContextMessages(
      messages || [],
      session ? rinPressurePruningOptions(session) : undefined,
    ),
    helpers.estimateContextTokens,
  );
}

function estimateContextAfterPressureStep(
  messages: any[],
  contextTokens: number,
  nextBuckets: number,
  session: any,
  helpers: { estimateContextTokens?: (messages: any[]) => any },
) {
  const nextMessages = pruneSessionContextMessages(messages || [], {
    ...rinPressurePruningOptions(session),
    retainedToolCallBuckets: nextBuckets,
  });
  const currentEstimate = estimateProviderBoundContextTokens(
    withoutAssistantUsage(messages || []),
    helpers.estimateContextTokens,
  );
  const nextEstimate = estimateProviderBoundContextTokens(
    withoutAssistantUsage(nextMessages),
    helpers.estimateContextTokens,
  );
  const savedTokens = Math.max(0, currentEstimate - nextEstimate);
  return {
    contextTokens: Math.max(0, contextTokens - savedTokens),
    messages: nextMessages,
  };
}

function reduceRinPressureBeforeCompaction(
  session: any,
  contextTokens: number,
  contextWindow: number,
  settings: any,
  helpers: { estimateContextTokens?: (messages: any[]) => any },
  providerMessages?: any[],
) {
  let reducedMessages =
    providerMessages ||
    buildRinPressureContextMessages(
      getSessionProviderContextMessages(session),
      rinPressurePruningOptions(session),
    );
  let retainedBuckets = getRinPressureRetainedToolCallBuckets(session);
  let reducedTokens = contextTokens;
  while (
    retainedBuckets > 1 &&
    shouldTriggerRinCompaction(reducedTokens, contextWindow, settings)
  ) {
    const nextBuckets = retainedBuckets - 1;
    const next = estimateContextAfterPressureStep(
      reducedMessages,
      reducedTokens,
      nextBuckets,
      session,
      helpers,
    );
    reducedMessages = next.messages;
    reducedTokens = next.contextTokens;
    retainedBuckets = nextBuckets;
    setRinPressureRetainedToolCallBuckets(session, retainedBuckets);
  }
  return {
    contextTokens: reducedTokens,
    retainedBuckets,
    messages: reducedMessages,
  };
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
    const tokens = estimateCurrentProviderContextTokens(
      getSessionProviderContextMessages(this),
      helpers,
      this,
    );
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

function canRunOverflowPreflightFromProviderMessages(messages: any[]) {
  const last = Array.isArray(messages) ? messages[messages.length - 1] : null;
  return Boolean(last && last.role !== "assistant");
}

function syncProviderPreflightMessages(target: any[], source: any[]) {
  if (!Array.isArray(target) || !Array.isArray(source)) return;
  target.splice(0, target.length, ...source);
}

function getLatestRinCompactionEntry(session: any, helpers: any) {
  return (
    helpers.getLatestCompactionEntry?.(
      session?.sessionManager?.getBranch?.() || [],
    ) || null
  );
}

function getRinCompactionEntryKey(entry: any) {
  if (!entry) return "";
  return `${entry.id || ""}:${entry.timestamp || ""}`;
}

function buildRinAgentLoopContextSnapshot(session: any, fallbackContext?: any) {
  const state = session?.agent?.state || {};
  const messages = getSessionProviderContextMessages(session).slice();
  const tools = Array.isArray(state.tools)
    ? state.tools.slice()
    : fallbackContext?.tools;
  return {
    ...(fallbackContext || {}),
    systemPrompt:
      typeof state.systemPrompt === "string"
        ? state.systemPrompt
        : fallbackContext?.systemPrompt,
    messages,
    tools,
  };
}

async function maybeRunRinMidTurnThresholdCompaction(
  session: any,
  assistantMessage: any,
  settings: any,
  helpers: {
    calculateContextTokens?: (usage: any) => number;
    estimateContextTokens?: (messages: any[]) => any;
    getLatestCompactionEntry?: (entries: any[]) => any;
  },
) {
  if (assistantMessage?.stopReason !== "toolUse") return false;
  if (session.isCompacting) return false;

  const contextWindow = Number(session.model?.contextWindow || 0);
  const compactionEntry = getLatestRinCompactionEntry(session, helpers);
  if (
    compactionEntry &&
    assistantMessage?.timestamp <= new Date(compactionEntry.timestamp).getTime()
  ) {
    return false;
  }

  const messages = getSessionProviderContextMessages(session);
  const estimatedTokens = estimateCurrentProviderContextTokens(
    messages,
    helpers,
    session,
  );
  const usageTokens = Number(
    helpers.calculateContextTokens?.(assistantMessage?.usage) || 0,
  );
  const contextTokens = Math.max(estimatedTokens, usageTokens);
  if (!shouldTriggerRinCompaction(contextTokens, contextWindow, settings)) {
    return false;
  }
  const pressure = reduceRinPressureBeforeCompaction(
    session,
    contextTokens,
    contextWindow,
    settings,
    helpers,
  );
  if (
    !shouldTriggerRinCompaction(pressure.contextTokens, contextWindow, settings)
  ) {
    return false;
  }

  const beforeKey = getRinCompactionEntryKey(compactionEntry);
  await runPiSessionAutoCompaction(session, "threshold", false);
  const afterKey = getRinCompactionEntryKey(
    getLatestRinCompactionEntry(session, helpers),
  );
  return Boolean(afterKey && afterKey !== beforeKey);
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
    providerMessages = pruneSessionContextMessages(
      providerMessages,
      rinPressurePruningOptions(session),
    );
    if (!canRunOverflowPreflightFromProviderMessages(providerMessages)) {
      return providerMessages;
    }
    const settings = session.settingsManager?.getCompactionSettings?.();
    if (!settings?.enabled || session.isCompacting) return providerMessages;

    const contextWindow = Number(session.model?.contextWindow || 0);
    const contextTokens = estimateProviderBoundContextTokens(
      providerMessages,
      helpers.estimateContextTokens,
    );
    if (!shouldTriggerRinCompaction(contextTokens, contextWindow, settings)) {
      return providerMessages;
    }
    const pressure = reduceRinPressureBeforeCompaction(
      session,
      contextTokens,
      contextWindow,
      settings,
      helpers,
      providerMessages,
    );
    providerMessages = pressure.messages;
    if (
      !shouldTriggerRinCompaction(
        pressure.contextTokens,
        contextWindow,
        settings,
      )
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
    return pruneSessionContextMessages(
      providerMessages,
      rinPressurePruningOptions(session),
    );
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

  const agent = session.agent;
  if (
    agent &&
    typeof agent === "object" &&
    !session[MID_TURN_THRESHOLD_COMPACTION_KEY]
  ) {
    const originalPrepareNextTurn =
      typeof agent.prepareNextTurn === "function"
        ? agent.prepareNextTurn.bind(agent)
        : undefined;
    agent.prepareNextTurn = async function rinMidTurnThresholdPrepareNextTurn(
      signal?: AbortSignal,
    ) {
      const originalSnapshot = originalPrepareNextTurn
        ? await originalPrepareNextTurn(signal)
        : undefined;
      const settings = session.settingsManager?.getCompactionSettings?.();
      if (!settings?.enabled) return originalSnapshot;
      const compacted = await maybeRunRinMidTurnThresholdCompaction(
        session,
        session._lastAssistantMessage,
        settings,
        helpers,
      );
      if (!compacted) return originalSnapshot;
      return {
        ...(originalSnapshot || {}),
        context: buildRinAgentLoopContextSnapshot(
          session,
          originalSnapshot?.context,
        ),
      };
    };
    session[MID_TURN_THRESHOLD_COMPACTION_KEY] = { originalPrepareNextTurn };
  }

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

      // Pi calls _checkCompaction with the default skipAbortedCheck=true after
      // an assistant message completes. Disable that completion-time threshold
      // compaction path while preserving pre-prompt checks and overflow recovery.
      if (skipAbortedCheck) return false;

      const estimatedTokens = estimateCurrentProviderContextTokens(
        getSessionProviderContextMessages(this),
        helpers,
        this,
      );
      const usageTokens = Number(
        helpers.calculateContextTokens(assistantMessage?.usage) || 0,
      );
      const contextTokens =
        assistantMessage?.stopReason === "error"
          ? estimatedTokens
          : Math.max(estimatedTokens, usageTokens);
      if (!shouldTriggerRinCompaction(contextTokens, contextWindow, settings)) {
        return false;
      }
      const pressure = reduceRinPressureBeforeCompaction(
        this,
        contextTokens,
        contextWindow,
        settings,
        helpers,
      );
      if (
        !shouldTriggerRinCompaction(
          pressure.contextTokens,
          contextWindow,
          settings,
        )
      ) {
        return false;
      }
      return await runPiSessionAutoCompaction(this, "threshold", false);
    },
  );

  session[COMPACTION_PERCENT_THRESHOLD_KEY] = { originalCheckCompaction };
}

export function applyAutoReloadAfterCompaction(session: any) {
  if (!session || typeof session !== "object") return;
  if ((session as any)[AUTO_RELOAD_AFTER_COMPACTION_KEY]) return;
  if (typeof session.subscribe !== "function") return;
  if (typeof session.reload !== "function") return;

  let reloadInFlight: Promise<void> | null = null;
  let reloadQueued = false;
  let reloadScheduled = false;

  const runReload = () => {
    if (reloadInFlight) {
      reloadQueued = true;
      return reloadInFlight;
    }

    const pressureGeneration = getRinPressurePruningGeneration(session);
    let reloadSucceeded = false;
    reloadInFlight = (async () => {
      try {
        await session.reload();
        reloadSucceeded = true;
      } catch {}
    })().finally(() => {
      if (
        reloadSucceeded &&
        getRinPressurePruningGeneration(session) === pressureGeneration
      ) {
        resetRinPressureRetainedToolCallBuckets(session);
      }
      reloadInFlight = null;
      if (!reloadQueued) return;
      reloadQueued = false;
      reloadScheduled = true;
      setTimeout(() => {
        reloadScheduled = false;
        void requestCompactionReload();
      }, 0);
    });

    return reloadInFlight;
  };

  let compactionDepth = 0;
  let pendingCompactionReload = false;
  let agentTurnActive = false;
  let reloadAfterAgentEnd = false;

  const requestCompactionReload = async () => {
    if (agentTurnActive) {
      reloadAfterAgentEnd = true;
      return;
    }
    await runReload();
  };

  const finishCompactionReload = async () => {
    compactionDepth -= 1;
    if (compactionDepth > 0 || !pendingCompactionReload) return;
    pendingCompactionReload = false;
    await requestCompactionReload();
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

  const originalPrompt =
    typeof session.prompt === "function" ? session.prompt.bind(session) : null;
  if (originalPrompt) {
    session.prompt = async function waitForCompactionReloadBeforePrompt(
      ...args: any[]
    ) {
      while (
        reloadInFlight ||
        reloadScheduled ||
        reloadQueued ||
        reloadAfterAgentEnd ||
        pendingCompactionReload ||
        compactionDepth > 0
      ) {
        if (reloadInFlight) {
          await reloadInFlight;
        } else {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      return await originalPrompt(...args);
    };
  }

  const unsubscribe = session.subscribe((event: any) => {
    if (event?.type === "agent_start") {
      agentTurnActive = true;
      return;
    }
    if (event?.type === "agent_end") {
      agentTurnActive = false;
      if (!reloadAfterAgentEnd) return;
      reloadAfterAgentEnd = false;
      void runReload();
      return;
    }
    if (event?.type !== "compaction_end") return;
    if (event?.aborted || !event?.result) return;
    if (compactionDepth > 0) {
      pendingCompactionReload = true;
      return;
    }
    void requestCompactionReload();
  });

  (session as any)[AUTO_RELOAD_AFTER_COMPACTION_KEY] = {
    unsubscribe,
    originalRunAutoCompaction,
    originalCompact,
    originalPrompt,
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

function applyStartupSessionName(sessionManager: any, sessionName?: unknown) {
  const name = String(sessionName || "").trim();
  if (!name || typeof sessionManager?.appendSessionInfo !== "function") return;
  const current = String(sessionManager.getSessionName?.() || "").trim();
  if (current === name) return;
  sessionManager.appendSessionInfo(name);
}

export function applyRinExtensionContextApi(session: any, agentDir: string) {
  const runner = session?.extensionRunner;
  if (!runner?.createContext || !runner?.createCommandContext) return;
  for (const method of ["createContext", "createCommandContext"]) {
    const original = runner[method].bind(runner);
    runner[method] = (...args: unknown[]) => {
      const context = original(...args);
      const rinContext: Record<string, unknown> = { agentDir };
      Object.defineProperty(rinContext, "frontendIdentity", {
        enumerable: true,
        get: () => session.sessionManager?.__rinFrontend,
      });
      context.rin = rinContext;
      return context;
    };
  }
}

export async function createConfiguredAgentSession(
  options: RinToolStartupOptions &
    RinPiPassthroughOptions & {
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
      customTools?: any[];
      selfImproveTurnWindowTurns?: number;
    } = {},
) {
  const agentRuntimeModule = await loadRinAgentRuntime();
  const {
    calculateContextTokens,
    createAgentSessionRuntime,
    createAgentSessionServices,
    createAgentSessionFromServices,
    estimateContextTokens,
    getLatestCompactionEntry,
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
    const promptState: LazySystemPromptState = {
      materialized: false,
      systemPrompt: "",
      ignorePersistedPrompt: false,
      agentDir: runtimeAgentDir,
    };
    const piServiceOptions = options.piAgentSessionServicesOptions ?? {};
    const piResourceLoaderOptions =
      (piServiceOptions.resourceLoaderOptions as Record<string, unknown>) ?? {};
    const services = await createAgentSessionServices({
      ...piServiceOptions,
      cwd: runtimeCwd,
      agentDir: runtimeAgentDir,
      settingsManager,
      resourceLoaderOptions: {
        ...piResourceLoaderOptions,
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
        selfImproveTurnWindowTurns:
          options.selfImproveTurnWindowTurns ??
          services.settingsManager?.settings?.selfImprove?.turnWindowTurns,
      }),
    });

    const result = await createAgentSessionFromServices({
      ...(options.piAgentSessionOptions ?? {}),
      services,
      sessionManager,
      sessionStartEvent,
      model: resolvedModel,
      thinkingLevel: options.thinkingLevel,
      tools: options.tools,
      excludeTools: options.excludeTools,
      noTools: options.noTools,
      customTools: [
        ...rinCapabilities.getToolDefinitions(),
        ...(options.customTools || []),
      ],
    });
    sessionRef.current = result.session;
    if (
      !installPiSessionCompactionOwner(result.session, (event) =>
        runPiNativeCompactionWithoutFileSummary(
          result.session,
          buildProviderBoundCompactionEvent(
            event,
            getSessionProviderContextMessages(result.session),
            {
              cwd: runtimeCwd,
              retainedToolCallBuckets: getRinPressureRetainedToolCallBuckets(
                result.session,
              ),
            },
          ),
        ),
      )
    ) {
      throw new Error("rin_compaction_owner_unavailable");
    }
    if (sessionManager?.[EPHEMERAL_FORK_DISABLE_ROUTINE_COMPACTION_KEY]) {
      result.session[EPHEMERAL_FORK_DISABLE_ROUTINE_COMPACTION_KEY] = true;
    }

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

    applyRinExtensionContextApi(result.session, agentDir);
    applyRinPromptBuilder(result.session, promptState);
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
