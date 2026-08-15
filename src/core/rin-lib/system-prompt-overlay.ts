import path from "node:path";

import {
  formatSkillsForPrompt,
  type BuildSystemPromptOptions,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

const PROMPT_PREFIX = "As the assistant, you must fulfill the user's requests.";
const RUNTIME_AWARENESS = "You are running in the Rin runtime environment.";
const WEB_SOURCE_REQUIREMENT =
  "Always check Rin memory and search current authoritative web sources before answering; never rely on model knowledge alone.";

const RIN_GENERAL_GUIDELINES = [
  "Show file paths clearly when working with files",
  "Do not stop after one action if the user's request obviously requires multiple concrete steps",
];
const RIN_BASH_GUIDELINES = [
  "Use bash for file operations like ls, rg, find",
  "When using bash, explain meaningful findings instead of pasting excessive raw output",
];

export const RIN_SYSTEM_PROMPT_EXTENSION_NAME = "rin-system-prompt";

export type RinSystemPromptOptions = BuildSystemPromptOptions;

export type RinSystemPromptInput = {
  piOptions: RinSystemPromptOptions;
  agentDir: string;
  selfImprovePromptBlock?: string;
};

function uniqueNonempty(values: readonly unknown[]) {
  const unique = new Map<string, string>();
  for (const value of values) {
    const text = String(value || "").trim();
    const key = text.replace(/[.!?]+$/u, "").toLowerCase();
    if (key && !unique.has(key)) unique.set(key, text);
  }
  return [...unique.values()];
}

function buildToolsBlock(options: RinSystemPromptOptions) {
  const snippets = options.toolSnippets || {};
  const visibleTools = (options.selectedTools || []).filter((name) =>
    Boolean(String(snippets[name] || "").trim()),
  );
  const tools = visibleTools.length
    ? visibleTools
        .map((name) => `- ${name}: ${String(snippets[name]).trim()}`)
        .join("\n")
    : "(none)";
  return [
    `Available tools:\n${tools}`,
    "In addition to the tools above, you may have access to other custom tools depending on the project.",
  ].join("\n\n");
}

function buildGuidelinesBlock(options: RinSystemPromptOptions) {
  const activeTools = new Set(options.selectedTools || []);
  const guidelines = uniqueNonempty([
    ...RIN_GENERAL_GUIDELINES,
    ...(activeTools.has("bash") ? RIN_BASH_GUIDELINES : []),
    ...(options.promptGuidelines || []),
  ]);
  return guidelines.length
    ? `Guidelines:\n${guidelines.map((line) => `- ${line}`).join("\n")}`
    : "";
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
    "- Topic routes: session awareness -> docs/session-awareness.md; subagents -> docs/non-interactive-cli.md; scheduled tasks -> docs/agent-sdk.md + docs/scheduled-tasks.md; rich chat output -> docs/rich-text-output-format.md; chat bridge -> docs/chat-bridge.md; runtime layout -> docs/runtime-layout.md; capabilities/update/rollback -> docs/capabilities.md.",
    "- Core scheduled tasks: use real scheduled/background tasks for reminders, delayed follow-ups, recurring work, polling/watch work, and work that must continue after the current turn.",
    "- Core rich text: use Rin rich text for native mentions, replies/quotes, images, files, audio, video, stickers, and chat attachments. In chat input, `[quote:<message-id>]` is a lazy reference under the current `chatKey`; call `rin.chat.messages.get({ chatKey, messageId })` only when the request depends on it, and follow nested quote nodes only as needed.",
    "- Use Pi docs only for topics not covered by Rin docs, after applying Rin overrides.",
  ].join("\n");
}

function buildContextFilesBlock(options: RinSystemPromptOptions) {
  const contextFiles = options.contextFiles || [];
  if (contextFiles.length === 0) return "";
  return [
    "<project_context>",
    "",
    "Project-specific instructions and guidelines:",
    "",
    ...contextFiles.flatMap(({ path: filePath, content }) => [
      `<project_instructions path="${filePath}">`,
      content,
      "</project_instructions>",
      "",
    ]),
    "</project_context>",
  ].join("\n");
}

function buildSkillsBlock(options: RinSystemPromptOptions) {
  if (!(options.selectedTools || []).includes("read")) return "";
  return formatSkillsForPrompt(options.skills || []).trim();
}

export function buildRinSystemPrompt(input: RinSystemPromptInput) {
  const options = input.piOptions;
  const sections = [
    [PROMPT_PREFIX, RUNTIME_AWARENESS, WEB_SOURCE_REQUIREMENT].join("\n"),
  ];

  if (options.customPrompt) {
    sections.push(options.customPrompt);
  } else {
    sections.push(buildToolsBlock(options), buildGuidelinesBlock(options));
  }

  sections.push(
    buildRinDocsBlock(input.agentDir),
    String(options.appendSystemPrompt || ""),
    buildContextFilesBlock(options),
    buildSkillsBlock(options),
    String(input.selfImprovePromptBlock || ""),
  );

  return sections.filter((section) => section !== "").join("\n\n");
}

export function readPiPublicSystemPromptOptions(
  session: any,
  fallbackCwd = "",
): RinSystemPromptOptions {
  const activeTools = session?.getActiveToolNames?.();
  const selectedTools = Array.isArray(activeTools) ? activeTools : [];
  const toolSnippets: Record<string, string> = {};
  const promptGuidelines: string[] = [];
  for (const name of selectedTools) {
    const definition = session?.getToolDefinition?.(name);
    const snippet = String(definition?.promptSnippet || "").trim();
    if (snippet) toolSnippets[name] = snippet;
    if (Array.isArray(definition?.promptGuidelines)) {
      promptGuidelines.push(...definition.promptGuidelines);
    }
  }

  const resourceLoader = session?.resourceLoader;
  const appendSystemPrompt = resourceLoader?.getAppendSystemPrompt?.();
  const skills = resourceLoader?.getSkills?.()?.skills;
  const contextFiles = resourceLoader?.getAgentsFiles?.()?.agentsFiles;
  return {
    cwd: String(fallbackCwd || ""),
    customPrompt: resourceLoader?.getSystemPrompt?.(),
    selectedTools,
    toolSnippets,
    promptGuidelines,
    appendSystemPrompt: Array.isArray(appendSystemPrompt)
      ? appendSystemPrompt.join("\n\n") || undefined
      : undefined,
    contextFiles: Array.isArray(contextFiles) ? contextFiles : [],
    skills: Array.isArray(skills) ? skills : [],
  };
}

export function createRinSystemPromptExtension(
  resolvePrompt: (options: RinSystemPromptOptions, context: any) => string,
): InlineExtension {
  return {
    name: RIN_SYSTEM_PROMPT_EXTENSION_NAME,
    factory: (pi) => {
      pi.on("before_agent_start", (event, context) => ({
        systemPrompt: resolvePrompt(event.systemPromptOptions, context),
      }));
    },
  };
}
