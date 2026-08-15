import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const runtimeMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "runtime.js"))
    .href
);
const promptMod = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-lib", "system-prompt-overlay.js"),
  ).href
);

function normalizePrompt(
  prompt: string,
  options: { cwd: string; agentDir: string },
) {
  return String(prompt)
    .split(options.agentDir)
    .join("<AGENT_DIR>")
    .split(options.cwd)
    .join("<CWD>");
}

async function buildPromptScenario(
  name: string,
  setup: {
    settings?: Record<string, unknown>;
    agents?: string;
    skill?: boolean;
    selfImprove?: string;
    tools?: string[];
    noTools?: "all" | "builtin";
    systemPrompt?: string;
    appendSystemPrompt?: string;
  } = {},
) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `rin-prompt-${name}-cwd-`));
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `rin-prompt-${name}-agent-`),
  );
  try {
    if (setup.settings) {
      fs.writeFileSync(
        path.join(agentDir, "settings.json"),
        JSON.stringify(setup.settings, null, 2),
      );
    }
    if (setup.agents) {
      fs.writeFileSync(path.join(cwd, "AGENTS.md"), setup.agents);
    }
    if (setup.skill) {
      const skillDir = path.join(agentDir, "skills", "demo");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        "---\nname: demo\ndescription: Demo skill\n---\n\n# Demo\n",
      );
    }
    if (setup.selfImprove) {
      const promptDir = path.join(agentDir, "self_improve", "prompts");
      fs.mkdirSync(promptDir, { recursive: true });
      fs.writeFileSync(
        path.join(promptDir, "user_profile.md"),
        setup.selfImprove,
      );
    }
    const configured = await runtimeMod.createConfiguredAgentSession({
      cwd,
      agentDir,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: !setup.agents,
      noSkills: !setup.skill,
      tools: setup.tools,
      noTools: setup.noTools,
      systemPrompt: setup.systemPrompt,
      appendSystemPrompt: setup.appendSystemPrompt
        ? [setup.appendSystemPrompt]
        : undefined,
    });
    try {
      return normalizePrompt(
        runtimeMod.ensureSessionBaseSystemPrompt(configured.session),
        { cwd, agentDir },
      );
    } finally {
      await configured.runtime.dispose();
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

test("Rin owns a canonical prompt built only from structured resources", () => {
  const prompt = promptMod.buildRinSystemPrompt({
    piOptions: {
      cwd: "/private/process/path",
      selectedTools: ["read"],
      toolSnippets: { read: "Read files" },
      promptGuidelines: ["Use read for owner-requested files."],
      appendSystemPrompt: "Owner append",
      contextFiles: [
        { path: "/tmp/AGENTS.md", content: "Project instruction" },
      ],
    },
    agentDir: "/tmp/rin-agent",
  });

  assert.match(prompt, /^As the assistant,/);
  assert.match(prompt, /Available tools:\n- read: Read files/);
  assert.match(prompt, /Use read for owner-requested files\./);
  assert.match(prompt, /Owner append/);
  assert.match(prompt, /Project instruction/);
  assert.doesNotMatch(prompt, /expert coding assistant operating inside pi/);
  assert.doesNotMatch(prompt, /Current working directory:/);
  assert.doesNotMatch(prompt, /private\/process\/path/);
});

test("Rin canonical prompt derives tool guidance once from active public metadata", () => {
  const prompt = promptMod.buildRinSystemPrompt({
    piOptions: {
      cwd: "/ignored",
      selectedTools: ["bash", "read"],
      toolSnippets: { bash: "Run commands", read: "Read files" },
      promptGuidelines: [
        "Use read to examine files instead of cat or sed.",
        "Use read to examine files instead of cat or sed.",
      ],
    },
    agentDir: "/tmp/rin-agent",
  });

  assert.equal(
    prompt.match(/Use read to examine files instead of cat or sed\./g)?.length,
    1,
  );
  assert.match(prompt, /Use bash for file operations like ls, rg, find/);
  assert.match(prompt, /- bash: Run commands/);
  assert.match(prompt, /- read: Read files/);
});

test("no-tools prompt contains no unavailable-tool instructions", () => {
  const prompt = promptMod.buildRinSystemPrompt({
    piOptions: { cwd: "/ignored", selectedTools: [] },
    agentDir: "/tmp/rin-agent",
  });

  assert.match(prompt, /Available tools:\n\(none\)/);
  assert.match(
    prompt,
    /Always check Rin memory and search current authoritative web sources before answering/,
  );
  assert.doesNotMatch(prompt, /Use bash /);
  assert.doesNotMatch(prompt, /Use read /);
  assert.doesNotMatch(prompt, /Use edit /);
});

test("custom prompt preserves structured append, context, skills, and Rin layers", () => {
  const prompt = promptMod.buildRinSystemPrompt({
    piOptions: {
      cwd: "/ignored",
      customPrompt: "CUSTOM BASE",
      selectedTools: ["read"],
      appendSystemPrompt: "APPEND BLOCK",
      contextFiles: [{ path: "/repo/AGENTS.md", content: "Project rule." }],
      skills: [
        {
          name: "demo",
          description: "Demo skill",
          filePath: "/skills/demo/SKILL.md",
          baseDir: "/skills/demo",
          sourceInfo: { source: "test", level: "explicit" },
          disableModelInvocation: false,
        },
      ],
    },
    agentDir: "/tmp/rin-agent",
    selfImprovePromptBlock: "Stable preference.",
  });

  assert.match(prompt, /CUSTOM BASE/);
  assert.match(prompt, /APPEND BLOCK/);
  assert.match(prompt, /<project_instructions path="\/repo\/AGENTS\.md">/);
  assert.match(prompt, /The following skills provide/);
  assert.match(prompt, /Stable preference\./);
  assert.doesNotMatch(prompt, /Available tools:/);
});

test("public Pi session data produces the structured Rin prompt options", () => {
  const options = promptMod.readPiPublicSystemPromptOptions(
    {
      getActiveToolNames: () => ["read"],
      getToolDefinition: () => ({
        promptSnippet: "Read files",
        promptGuidelines: ["Read only what is needed."],
      }),
      resourceLoader: {
        getSystemPrompt: () => "CUSTOM",
        getAppendSystemPrompt: () => ["A", "B"],
        getAgentsFiles: () => ({
          agentsFiles: [{ path: "/repo/AGENTS.md", content: "Rule" }],
        }),
        getSkills: () => ({ skills: [{ name: "demo" }] }),
      },
    },
    "/runtime/cwd",
  );

  assert.deepEqual(options, {
    cwd: "/runtime/cwd",
    customPrompt: "CUSTOM",
    selectedTools: ["read"],
    toolSnippets: { read: "Read files" },
    promptGuidelines: ["Read only what is needed."],
    appendSystemPrompt: "A\n\nB",
    contextFiles: [{ path: "/repo/AGENTS.md", content: "Rule" }],
    skills: [{ name: "demo" }],
  });
});

test("user extensions receive the Rin-owned prompt first", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rin-prompt-ext-cwd-"));
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-prompt-ext-agent-"),
  );
  const extensionPath = path.join(cwd, "observe-system-prompt.mjs");
  fs.writeFileSync(
    extensionPath,
    `export default function (pi) {
  pi.on("before_agent_start", (event) => {
    if (!event.systemPrompt.startsWith("As the assistant, you must fulfill the user's requests.")) {
      throw new Error("rin_prompt_missing_before_user_extension");
    }
    return { systemPrompt: event.systemPrompt + "\\n\\nUSER EXTENSION BLOCK" };
  });
}\n`,
  );
  try {
    const configured = await runtimeMod.createConfiguredAgentSession({
      cwd,
      agentDir,
      additionalExtensionPaths: [extensionPath],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    try {
      const basePrompt = runtimeMod.ensureSessionBaseSystemPrompt(
        configured.session,
      );
      const runner = configured.session._extensionRunner;
      const options = runner.createCommandContext().getSystemPromptOptions();
      const result = await runner.emitBeforeAgentStart(
        "probe",
        undefined,
        "PI PROSE MUST NOT SURVIVE",
        options,
      );
      assert.equal(
        result.systemPrompt,
        `${basePrompt}\n\nUSER EXTENSION BLOCK`,
      );
      assert.doesNotMatch(result.systemPrompt, /PI PROSE MUST NOT SURVIVE/);
    } finally {
      await configured.runtime.dispose();
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("runtime preserves six structured prompt scenarios", async () => {
  const actual = {
    default: await buildPromptScenario("default"),
    languageAppend: await buildPromptScenario("languageAppend", {
      settings: { language: "zh_CN" },
      appendSystemPrompt: "APPEND BLOCK",
    }),
    custom: await buildPromptScenario("custom", {
      systemPrompt: "CUSTOM BASE",
      appendSystemPrompt: "APPEND BLOCK",
      settings: { language: "ja_JP" },
    }),
    contextSkillSelf: await buildPromptScenario("contextSkillSelf", {
      agents: "Project rule.",
      skill: true,
      selfImprove: "Stable preference.",
      settings: { language: "zh_CN" },
    }),
    readTodo: await buildPromptScenario("readTodo", {
      tools: ["read", "todo"],
    }),
    noTools: await buildPromptScenario("noTools", { noTools: "all" }),
  };
  for (const prompt of Object.values(actual)) {
    assert.match(prompt, /^As the assistant,/);
    assert.doesNotMatch(prompt, /expert coding assistant operating inside pi/);
    assert.doesNotMatch(prompt, /Current working directory:/);
    assert.doesNotMatch(prompt, /Current date:/);
    assert.doesNotMatch(prompt, /Preferred language:/);
  }
  assert.match(
    actual.default,
    /Use bash for file operations like ls, rg, find/,
  );
  assert.match(actual.languageAppend, /APPEND BLOCK/);
  assert.match(actual.custom, /CUSTOM BASE/);
  assert.match(actual.custom, /APPEND BLOCK/);
  assert.match(actual.contextSkillSelf, /<project_context>/);
  assert.match(
    actual.contextSkillSelf,
    /<project_instructions path="<CWD>\/AGENTS\.md">/,
  );
  assert.match(actual.contextSkillSelf, /The following skills provide/);
  assert.match(actual.contextSkillSelf, /Stable preference\./);
  assert.match(actual.readTodo, /- todo:/);
  assert.match(
    actual.readTodo,
    /multiple concrete execution steps that benefit from a visible checklist/,
  );
  assert.match(actual.noTools, /Available tools:\n\(none\)/);
  assert.doesNotMatch(actual.noTools, /Use bash /);
  assert.doesNotMatch(actual.noTools, /chatKey/);
  assert.doesNotMatch(actual.noTools, /rin\.chat\.messages\.get/);
});
