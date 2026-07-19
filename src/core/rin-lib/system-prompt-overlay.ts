import path from "node:path";

const PROMPT_PREFIX = "As the assistant, you must fulfill the user's requests.";
const RUNTIME_AWARENESS = "You are running in the Rin runtime environment.";
const WEB_SOURCE_REQUIREMENT =
  "Always use a search engine to find current sources; treat built-in knowledge as outdated and authoritative online sources as the source of truth.";
const PI_GENERIC_OPENING =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

const RIN_EXTRA_GUIDELINES = [
  "Do not stop after one action if the user's request obviously requires multiple concrete steps",
  "When modifying files, prefer targeted edits and preserve existing style unless asked otherwise",
  "When using bash, explain meaningful findings instead of pasting excessive raw output",
];

export type RinSystemPromptOptions = {
  customPrompt?: string;
  selectedTools?: string[];
  toolSnippets?: Record<string, string>;
  promptGuidelines?: string[];
  appendSystemPrompt?: string;
  cwd?: string;
  contextFiles?: Array<{ path: string; content: string }>;
  skills?: Array<{
    name?: string;
    description?: string;
    baseDir?: string;
    disableModelInvocation?: boolean;
  }>;
};

export type RinSystemPromptOverlayInput = {
  piPrompt: string;
  piOptions: RinSystemPromptOptions;
  activeToolNames: string[];
  agentDir: string;
  configuredLanguageBlock?: string;
  selfImprovePromptBlock?: string;
  persistedBlocks?: string[];
};

function findRequiredAnchor(prompt: string, anchor: string, fromIndex = 0) {
  const index = prompt.indexOf(anchor, fromIndex);
  if (index < 0) throw new Error(`pi_prompt_shape_changed:${anchor}`);
  return index;
}

function findUniqueAnchorBefore(
  prompt: string,
  anchor: string,
  fromIndex: number,
  beforeIndex: number,
) {
  const first = prompt.indexOf(anchor, fromIndex);
  if (first < 0 || first >= beforeIndex) {
    throw new Error(`pi_prompt_shape_changed:${anchor}`);
  }
  const duplicate = prompt.indexOf(anchor, first + anchor.length);
  if (duplicate >= 0 && duplicate < beforeIndex) {
    throw new Error(`pi_prompt_shape_changed:duplicate:${anchor}`);
  }
  return first;
}

function validateActiveTools(
  options: RinSystemPromptOptions,
  activeToolNames: string[],
) {
  if (
    !Array.isArray(options.selectedTools) ||
    !Array.isArray(activeToolNames) ||
    options.selectedTools.length !== activeToolNames.length ||
    options.selectedTools.some((name, index) => name !== activeToolNames[index])
  ) {
    throw new Error("pi_prompt_shape_changed:selected_tools");
  }
  return activeToolNames;
}

function buildExpectedPiToolsPrefix(
  options: RinSystemPromptOptions,
  activeToolNames: string[],
) {
  const snippets = options.toolSnippets || {};
  const visibleTools = activeToolNames.filter((name) =>
    Boolean(snippets[name]),
  );
  const toolsList = visibleTools.length
    ? visibleTools.map((name) => `- ${name}: ${snippets[name]}`).join("\n")
    : "(none)";
  return `Available tools:\n${toolsList}`;
}

function removePiCwd(prompt: string, options: RinSystemPromptOptions) {
  if (typeof options.cwd !== "string" || !options.cwd) {
    throw new Error("pi_prompt_shape_changed:cwd_options");
  }
  const normalizedCwd = options.cwd.replace(/\\/g, "/");
  const suffix = `\nCurrent working directory: ${normalizedCwd}`;
  if (!prompt.endsWith(suffix)) {
    throw new Error("pi_prompt_shape_changed:cwd");
  }
  const cwdAt = prompt.length - suffix.length;
  return { prompt: prompt.slice(0, cwdAt), cwdAt };
}

function findPiDataBoundary(
  prompt: string,
  options: RinSystemPromptOptions,
  activeToolNames: string[],
  fromIndex: number,
  cwdAt: number,
) {
  if (cwdAt < fromIndex) {
    throw new Error("pi_prompt_shape_changed:data_boundary");
  }
  let boundary = cwdAt;
  const hasVisibleSkills = (options.skills || []).some(
    (skill) => skill && !skill.disableModelInvocation,
  );
  if (activeToolNames.includes("read") && hasVisibleSkills) {
    boundary = findUniqueAnchorBefore(
      prompt,
      "\n\nThe following skills provide specialized instructions for specific tasks.",
      fromIndex,
      boundary,
    );
  }
  if (Array.isArray(options.contextFiles) && options.contextFiles.length) {
    boundary = findUniqueAnchorBefore(
      prompt,
      "\n\n<project_context>\n\n",
      fromIndex,
      boundary,
    );
  }
  const appendSystemPrompt = String(options.appendSystemPrompt || "");
  if (appendSystemPrompt) {
    const anchor = `\n\n${appendSystemPrompt}`;
    const appendAt = prompt.lastIndexOf(
      anchor,
      Math.max(fromIndex, boundary - anchor.length),
    );
    if (appendAt < fromIndex || appendAt >= boundary) {
      throw new Error(`pi_prompt_shape_changed:${anchor}`);
    }
    boundary = appendAt;
  }
  return boundary;
}

function hasGuideline(block: string, guideline: string) {
  const rendered = `- ${guideline}`;
  return (
    block === rendered ||
    block.startsWith(`${rendered}\n`) ||
    block.endsWith(`\n${rendered}`) ||
    block.includes(`\n${rendered}\n`)
  );
}

function buildRinDocsBlock(agentDir: string) {
  const rinRoot = path.join(agentDir, "docs", "rin");
  const rinDocsRoot = path.join(rinRoot, "docs");
  const piRoot = path.join(agentDir, "docs", "pi");
  return [
    "Rin and Pi documentation:",
    `- Rin docs: ${path.join(rinRoot, "README.md")} and ${rinDocsRoot}`,
    `- Pi base docs: ${path.join(piRoot, "README.md")} and ${path.join(piRoot, "docs")}`,
    "- For Rin runtime, daemon, memory, scheduled task, chat, frontend, layout, update, or capability behavior, read Rin docs first; Rin overrides Pi.",
    "- Start runtime work with Rin README.md, docs/execution-environment.md, and docs/pi-overrides.md; then read only the narrow topic doc needed for the task.",
    "- Topic routes: browser/computer/mobile/search operation -> practices/README.md; session awareness -> docs/session-awareness.md; subagents -> docs/non-interactive-cli.md; scheduled tasks -> docs/agent-sdk.md + docs/scheduled-tasks.md; rich chat output -> docs/rich-text-output-format.md; chat bridge -> docs/chat-bridge.md; runtime layout -> docs/runtime-layout.md; capabilities/update/rollback -> docs/capabilities.md.",
    "- Core scheduled tasks: use real scheduled/background tasks for reminders, delayed follow-ups, recurring work, polling/watch work, and work that must continue after the current turn.",
    "- Core rich text: use Rin rich text for native mentions, replies/quotes, images, files, audio, video, stickers, and chat attachments.",
    "- Use Pi docs only for topics not covered by Rin docs, after applying Rin overrides.",
  ].join("\n");
}

function overlayDefaultPiPrompt(
  piPrompt: string,
  piOptions: RinSystemPromptOptions,
  activeToolNames: string[],
  cwdAt: number,
  docsBlock: string,
  configuredLanguageBlock: string | undefined,
) {
  const toolsAnchor = "Available tools:\n";
  const guidelinesAnchor = "\n\nGuidelines:\n";
  const docsAnchor = "\n\nPi documentation";
  const expectedOpening = `${PI_GENERIC_OPENING}\n\n`;
  if (!piPrompt.startsWith(`${expectedOpening}${toolsAnchor}`)) {
    throw new Error("pi_prompt_shape_changed:generic_opening");
  }
  const toolsAt = expectedOpening.length;
  const expectedToolsPrefix = buildExpectedPiToolsPrefix(
    piOptions,
    activeToolNames,
  );
  if (!piPrompt.startsWith(expectedToolsPrefix, toolsAt)) {
    throw new Error("pi_prompt_shape_changed:tools_block");
  }
  const toolsPrefixEnd = toolsAt + expectedToolsPrefix.length;
  const dataAt = findPiDataBoundary(
    piPrompt,
    piOptions,
    activeToolNames,
    toolsPrefixEnd,
    cwdAt,
  );
  const duplicateToolsAt = piPrompt.indexOf(toolsAnchor, toolsPrefixEnd);
  if (duplicateToolsAt >= 0 && duplicateToolsAt < dataAt) {
    throw new Error("pi_prompt_shape_changed:duplicate:Available tools");
  }
  const guidelinesAt = findUniqueAnchorBefore(
    piPrompt,
    guidelinesAnchor,
    toolsPrefixEnd,
    dataAt,
  );
  const guidelinesContentAt = guidelinesAt + guidelinesAnchor.length;
  const docsAt = findUniqueAnchorBefore(
    piPrompt,
    docsAnchor,
    guidelinesContentAt,
    dataAt,
  );
  const nativeGuidelines = piPrompt.slice(guidelinesContentAt, docsAt);
  const rinGuidelines = RIN_EXTRA_GUIDELINES.filter(
    (guideline) => !hasGuideline(nativeGuidelines, guideline),
  );
  const promptThroughGuidelines = [
    piPrompt.slice(toolsAt, docsAt),
    ...rinGuidelines.map((guideline) => `- ${guideline}`),
  ].join("\n");
  const nativeDocs = piPrompt.slice(docsAt, dataAt);
  const nativeDataTail = piPrompt.slice(dataAt, cwdAt);
  let prompt = `${promptThroughGuidelines}${nativeDocs}\n\n${docsBlock}`;
  if (configuredLanguageBlock) {
    prompt += `\n\n${configuredLanguageBlock}`;
  }
  return `${prompt}${nativeDataTail}`;
}

function applyPersistedBlocks(prompt: string, blocks: string[] | undefined) {
  let next = String(prompt || "");
  for (const value of Array.isArray(blocks) ? blocks : []) {
    const block = String(value || "").trim();
    if (!block || next.includes(block)) continue;
    next = `${next}\n\n${block}`;
  }
  return next;
}

export function applyRinSystemPromptOverlay(
  input: RinSystemPromptOverlayInput,
) {
  const activeToolNames = validateActiveTools(
    input.piOptions,
    input.activeToolNames,
  );
  const withoutCwd = removePiCwd(input.piPrompt, input.piOptions);
  const docsBlock = buildRinDocsBlock(input.agentDir);
  const customPrompt = input.piOptions.customPrompt;
  let prompt = customPrompt
    ? [withoutCwd.prompt, docsBlock, input.configuredLanguageBlock]
        .filter(Boolean)
        .join("\n\n")
    : overlayDefaultPiPrompt(
        input.piPrompt,
        input.piOptions,
        activeToolNames,
        withoutCwd.cwdAt,
        docsBlock,
        input.configuredLanguageBlock,
      );

  if (input.selfImprovePromptBlock) {
    prompt += `\n\n${input.selfImprovePromptBlock}`;
  }
  prompt = applyPersistedBlocks(prompt, input.persistedBlocks);
  return `${PROMPT_PREFIX}\n${RUNTIME_AWARENESS}\n${WEB_SOURCE_REQUIREMENT}\n\n${prompt}`;
}
