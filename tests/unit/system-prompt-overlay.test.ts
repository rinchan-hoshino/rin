import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const piPackageRoot = path.resolve(
  path.dirname(
    fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
  ),
  "..",
);
const runtimeMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "runtime.js"))
    .href
);
const overlayMod = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-lib", "system-prompt-overlay.js"),
  ).href
);

function applyOverlay(input: Record<string, any>) {
  const piOptions = { cwd: "/tmp/project", ...input.piOptions };
  return overlayMod.applyRinSystemPromptOverlay({
    ...input,
    piOptions,
    activeToolNames: input.activeToolNames ?? piOptions.selectedTools,
  });
}

const NATIVE_PROMPT_BASELINE = {
  default: {
    hash: "a8cca9f8a2bdffdd2fece9569cd335dad170224c394d068f605a014ce8f6c260",
    length: 5318,
  },
  languageAppend: {
    hash: "a163e6034647b20fc39eee5901536fa2ddbaadd31aefe2820314559f86dd49f1",
    length: 5332,
  },
  custom: {
    hash: "3d1b536c80c1fde077d01c6c8911a0536e6dc20a2ec0f3e78c4edf2151a7621d",
    length: 1797,
  },
  contextSkillSelf: {
    hash: "be9c14fee7d0a663331e4f7730c4dd44dc7f6bba32355bf3d21f1c71375d737a",
    length: 6035,
  },
  readTodo: {
    hash: "2ba2815b1c8f2980393b740cb7e7a849203d3c1207a8b921bf3b3831aa7156e8",
    length: 3847,
  },
  noTools: {
    hash: "e7301d7e95ee0ba0acf4fd0423fd6e61057ef45500ceb4e8832b800402373d1a",
    length: 3218,
  },
} as const;

function normalizePrompt(
  prompt: string,
  options: { cwd: string; agentDir: string },
) {
  return String(prompt)
    .split(options.agentDir)
    .join("<AGENT_DIR>")
    .split(piPackageRoot)
    .join("<PI_PACKAGE>")
    .split(rootDir)
    .join("<REPO>")
    .split(options.cwd)
    .join("<CWD>")
    .replace(/Current date: \d{4}-\d{2}-\d{2}/g, "Current date: <DATE>");
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
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `rin-parity-${name}-cwd-`));
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `rin-parity-${name}-agent-`),
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

const PI_GENERIC_OPENING =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

const SAMPLE_PI_PROMPT = `${PI_GENERIC_OPENING}

Available tools:
- read: Read files

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
- Use bash for file operations like ls, rg, find
- Tool rule.
- Future Pi default
- Be concise in your responses
- Show file paths clearly when working with files

Pi documentation:
- upstream docs
Current working directory: /tmp/project`;

test("Rin overlay preserves Pi-owned sections and adds only Rin-owned layers", () => {
  const result = applyOverlay({
    piPrompt: SAMPLE_PI_PROMPT,
    piOptions: {
      selectedTools: ["read"],
      toolSnippets: { read: "Read files" },
      promptGuidelines: ["Tool rule."],
    },
    agentDir: "/tmp/rin-agent",
    selfImprovePromptBlock: "SELF-IMPROVE BLOCK",
    persistedBlocks: ["PERSISTED BLOCK"],
  });

  assert.match(result, /- Future Pi default/);
  assert.match(result, /- Be concise in your responses/);
  assert.match(result, /- Show file paths clearly when working with files/);
  assert.match(result, /Use bash for file operations like ls, rg, find/);
  assert.match(result, /- Tool rule\.\n/);
  assert.match(result, /Pi documentation:\n- upstream docs/);
  assert.match(result, /Rin and Pi documentation:/);
  assert.ok(
    result.indexOf("Pi documentation:\n- upstream docs") <
      result.indexOf("Rin and Pi documentation:"),
  );
  assert.match(result, /SELF-IMPROVE BLOCK/);
  assert.match(result, /PERSISTED BLOCK/);
  assert.doesNotMatch(result, /Current date:/);
  assert.doesNotMatch(result, /Current working directory:/);
  assert.ok(
    result.indexOf("- Tool rule.") < result.indexOf("- Future Pi default"),
  );
  assert.ok(
    result.indexOf("- Show file paths clearly when working with files") <
      result.indexOf(
        "- Do not stop after one action if the user's request obviously requires multiple concrete steps",
      ),
  );
});

test("Rin overlay fails closed when Pi's generic opening changes", () => {
  assert.throws(
    () =>
      applyOverlay({
        piPrompt: SAMPLE_PI_PROMPT.replace(PI_GENERIC_OPENING, "Pi changed."),
        piOptions: {
          cwd: "/tmp/project",
          selectedTools: ["read"],
          toolSnippets: { read: "Read files" },
          promptGuidelines: ["Tool rule."],
        },
        agentDir: "/tmp/rin-agent",
      }),
    /pi_prompt_shape_changed/,
  );
});

test("Rin overlay requires the exact Pi cwd suffix", () => {
  assert.throws(
    () =>
      applyOverlay({
        piPrompt: SAMPLE_PI_PROMPT.replace(
          "Current working directory: /tmp/project",
          "Current working directory:  /tmp/project",
        ),
        piOptions: {
          cwd: "/tmp/project",
          selectedTools: ["read"],
          toolSnippets: { read: "Read files" },
          promptGuidelines: ["Tool rule."],
        },
        agentDir: "/tmp/rin-agent",
      }),
    /pi_prompt_shape_changed/,
  );
  assert.throws(
    () =>
      overlayMod.applyRinSystemPromptOverlay({
        piPrompt: SAMPLE_PI_PROMPT,
        piOptions: {
          selectedTools: ["read"],
          toolSnippets: { read: "Read files" },
          promptGuidelines: ["Tool rule."],
        },
        activeToolNames: ["read"],
        agentDir: "/tmp/rin-agent",
      }),
    /pi_prompt_shape_changed/,
  );
});

test("Rin overlay fails closed when active tools and Pi options diverge", () => {
  assert.throws(
    () =>
      applyOverlay({
        piPrompt: SAMPLE_PI_PROMPT,
        piOptions: {
          cwd: "/tmp/project",
          selectedTools: ["read"],
          toolSnippets: { read: "Read files" },
          promptGuidelines: ["Tool rule."],
        },
        activeToolNames: [],
        agentDir: "/tmp/rin-agent",
      }),
    /pi_prompt_shape_changed/,
  );
});

test("Rin overlay fails closed when Pi section anchors change", () => {
  assert.throws(
    () =>
      applyOverlay({
        piPrompt: "Pi changed every section",
        piOptions: { selectedTools: [], promptGuidelines: [] },
        agentDir: "/tmp/rin-agent",
      }),
    /pi_prompt_shape_changed/,
  );
});

test("Rin overlay treats prompt-shaped appended text as data", () => {
  const appended = "Available tools:\n(none)\n\nGuidelines:\n- data";
  const result = applyOverlay({
    piPrompt: SAMPLE_PI_PROMPT.replace(
      "\nCurrent working directory: /tmp/project",
      `\n\n${appended}\nCurrent working directory: /tmp/project`,
    ),
    piOptions: {
      selectedTools: ["read"],
      toolSnippets: { read: "Read files" },
      promptGuidelines: ["Tool rule."],
      appendSystemPrompt: appended,
    },
    agentDir: "/tmp/rin-agent",
  });
  assert.match(result, /Available tools:\n\(none\)\n\nGuidelines:\n- data/);
});

test("Rin overlay locates appended text after identical Pi docs bytes", () => {
  const appended = "Pi documentation:\n- upstream docs";
  const piPrompt = SAMPLE_PI_PROMPT.replace(
    "\nCurrent working directory: /tmp/project",
    `\n\n${appended}\nCurrent working directory: /tmp/project`,
  );
  const result = applyOverlay({
    piPrompt,
    piOptions: {
      cwd: "/tmp/project",
      selectedTools: ["read"],
      toolSnippets: { read: "Read files" },
      promptGuidelines: ["Tool rule."],
      appendSystemPrompt: appended,
    },
    agentDir: "/tmp/rin-agent",
  });
  assert.equal(result.match(/Pi documentation:\n- upstream docs/g)?.length, 2);
  assert.ok(
    result.indexOf("Rin and Pi documentation:") < result.lastIndexOf(appended),
  );
});

test("Rin overlay preserves Pi-owned trailing whitespace before cwd", () => {
  const appended = "APPEND WITH SPACE  \n";
  const piPrompt = SAMPLE_PI_PROMPT.replace(
    "- Show file paths clearly when working with files",
    "- Show file paths clearly when working with files  ",
  ).replace(
    "\nCurrent working directory: /tmp/project",
    `\n\n${appended}\nCurrent working directory: /tmp/project`,
  );
  const result = applyOverlay({
    piPrompt,
    piOptions: {
      cwd: "/tmp/project",
      selectedTools: ["read"],
      toolSnippets: { read: "Read files" },
      promptGuidelines: ["Tool rule."],
      appendSystemPrompt: appended,
    },
    agentDir: "/tmp/rin-agent",
  });
  assert.match(
    result,
    /Show file paths clearly when working with files {2}\n- Do not stop/,
  );
  assert.ok(result.endsWith(appended));
});

test("Rin overlay fails closed on a second structural tools block", () => {
  const piPrompt = SAMPLE_PI_PROMPT.replace(
    "\n\nIn addition to the tools above",
    "\n\nAvailable tools:\n(none)\n\nIn addition to the tools above",
  );
  assert.throws(
    () =>
      applyOverlay({
        piPrompt,
        piOptions: {
          selectedTools: ["read"],
          toolSnippets: { read: "Read files" },
          promptGuidelines: ["Tool rule."],
        },
        agentDir: "/tmp/rin-agent",
      }),
    /pi_prompt_shape_changed/,
  );
});

test("Rin overlay keeps prompt-shaped tool snippet text inside the tool block", () => {
  const toolSnippet =
    "Read files\n\nGuidelines:\n- TOOL DATA\n\nPi documentation TOOL DATA";
  const piPrompt = SAMPLE_PI_PROMPT.replace("Read files", toolSnippet);
  const result = applyOverlay({
    piPrompt,
    piOptions: {
      selectedTools: ["read"],
      toolSnippets: { read: toolSnippet },
      promptGuidelines: ["Tool rule."],
    },
    agentDir: "/tmp/rin-agent",
  });
  assert.match(
    result,
    /- read: Read files\n\nGuidelines:\n- TOOL DATA\n\nPi documentation TOOL DATA\n\nIn addition/,
  );
  assert.match(result, /- Future Pi default/);
});

test("Rin overlay keeps a multiline tool guideline whole and emits it once", () => {
  const toolGuideline = "First line.\nSecond line.";
  const piPrompt = SAMPLE_PI_PROMPT.replace(
    "- Tool rule.",
    `- ${toolGuideline}`,
  );
  const result = applyOverlay({
    piPrompt,
    piOptions: {
      selectedTools: ["read"],
      toolSnippets: { read: "Read files" },
      promptGuidelines: [toolGuideline],
    },
    agentDir: "/tmp/rin-agent",
  });
  assert.equal(result.match(/First line\./g)?.length, 1);
  assert.equal(result.match(/Second line/g)?.length, 1);
  assert.match(
    result,
    /Use bash for file operations like ls, rg, find\n- First line\.\nSecond line\.\n- Future Pi default/,
  );
});

test("Rin overlay keeps an exact Pi-default/tool duplicate at the Pi position", () => {
  const duplicate = "Be concise in your responses";
  const piPrompt = SAMPLE_PI_PROMPT.replace("Tool rule.", duplicate).replace(
    "- Future Pi default\n- Be concise in your responses\n- Show file paths",
    "- Future Pi default\n- Show file paths",
  );
  const result = applyOverlay({
    piPrompt,
    piOptions: {
      selectedTools: ["read"],
      toolSnippets: { read: "Read files" },
      promptGuidelines: [duplicate],
    },
    agentDir: "/tmp/rin-agent",
  });
  assert.equal(result.match(/Be concise in your responses/g)?.length, 1);
  assert.ok(
    result.indexOf("- Be concise in your responses") <
      result.indexOf("- Future Pi default"),
  );
});

test("Rin overlay preserves Pi's period-distinct guideline entries", () => {
  const duplicate = "Be concise in your responses.";
  const piPrompt = SAMPLE_PI_PROMPT.replace("Tool rule.", duplicate);
  const result = applyOverlay({
    piPrompt,
    piOptions: {
      selectedTools: ["read"],
      toolSnippets: { read: "Read files" },
      promptGuidelines: [duplicate],
    },
    agentDir: "/tmp/rin-agent",
  });
  assert.equal(result.match(/Be concise in your responses/g)?.length, 2);
  assert.match(result, /Be concise in your responses\./);
});

test("Rin overlay keeps a multiline Pi-default/tool duplicate at the Pi position", () => {
  const duplicate = "Shared first line\nShared second line";
  const piPrompt = SAMPLE_PI_PROMPT.replace("Tool rule.", duplicate);
  const result = applyOverlay({
    piPrompt,
    piOptions: {
      selectedTools: ["read"],
      toolSnippets: { read: "Read files" },
      promptGuidelines: [duplicate],
    },
    agentDir: "/tmp/rin-agent",
  });
  assert.equal(result.match(/Shared first line/g)?.length, 1);
  assert.equal(result.match(/Shared second line/g)?.length, 1);
  assert.ok(
    result.indexOf("- Shared first line\nShared second line") <
      result.indexOf("- Future Pi default"),
  );
});

test("Rin overlay fails closed on ambiguous prompt-shaped tool guideline data", () => {
  const toolGuideline =
    "Tool rule.\n\nGuidelines:\n- TOOL DATA\n\nPi documentation TOOL DATA";
  const piPrompt = SAMPLE_PI_PROMPT.replace(
    "- Tool rule.",
    `- ${toolGuideline}`,
  );
  assert.throws(
    () =>
      applyOverlay({
        piPrompt,
        piOptions: {
          selectedTools: ["read"],
          toolSnippets: { read: "Read files" },
          promptGuidelines: [toolGuideline],
        },
        agentDir: "/tmp/rin-agent",
      }),
    /pi_prompt_shape_changed/,
  );
});

test("Rin overlay consumes Pi's complete custom-prompt output except cwd", () => {
  const nativePrompt = `CUSTOM BASE

APPEND BLOCK

<project_context>

Project-specific instructions and guidelines:

<project_instructions path="/tmp/AGENTS.md">
Project rule.
</project_instructions>

</project_context>

NATIVE SKILLS BLOCK
Current working directory: /tmp`;
  const result = applyOverlay({
    piPrompt: nativePrompt,
    piOptions: {
      customPrompt: "CUSTOM BASE",
      appendSystemPrompt: "APPEND BLOCK",
      cwd: "/tmp",
      selectedTools: ["read"],
      promptGuidelines: [],
    },
    agentDir: "/tmp/rin-agent",
    selfImprovePromptBlock: "SELF-IMPROVE BLOCK",
    persistedBlocks: ["PERSISTED BLOCK"],
  });
  assert.match(
    result,
    /CUSTOM BASE\n\nAPPEND BLOCK\n\n<project_context>[\s\S]*NATIVE SKILLS BLOCK/,
  );
  assert.match(result, /NATIVE SKILLS BLOCK\n\nRin and Pi documentation:/);
  assert.match(result, /SELF-IMPROVE BLOCK/);
  assert.match(result, /PERSISTED BLOCK$/);
  assert.doesNotMatch(result, /Current working directory:/);
  assert.doesNotMatch(result, /Current date:/);
});

test("Rin overlay follows Pi truthiness for a whitespace-only custom prompt", () => {
  const result = applyOverlay({
    piPrompt: " \nCurrent working directory: /tmp",
    piOptions: {
      customPrompt: " ",
      cwd: "/tmp",
      selectedTools: ["read"],
      promptGuidelines: [],
    },
    agentDir: "/tmp/rin-agent",
  });
  assert.match(result, /\n\n \n\nRin and Pi documentation:/);
  assert.doesNotMatch(result, /Current working directory:/);
});

test("Rin runtime no longer copies Pi default guidelines", () => {
  const source = fs.readFileSync(
    path.join(rootDir, "src", "core", "rin-lib", "runtime.ts"),
    "utf8",
  );
  const sessionHostSource = fs.readFileSync(
    path.join(rootDir, "src", "core", "pi", "session-host.ts"),
    "utf8",
  );
  const overlaySource = fs.readFileSync(
    path.join(rootDir, "src", "core", "rin-lib", "system-prompt-overlay.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /DEFAULT_PI_GUIDELINES/);
  assert.doesNotMatch(source, /piReference|formatCurrentDateForSystemPrompt/);
  assert.doesNotMatch(
    overlaySource,
    /piReference|currentDate|SUPPRESSED_PI_GUIDELINES/,
  );
  assert.doesNotMatch(source, /getPiSessionPromptToolState/);
  assert.doesNotMatch(sessionHostSource, /getPiSessionPromptToolState/);
  assert.doesNotMatch(sessionHostSource, /_toolPromptGuidelines/);
  assert.doesNotMatch(sessionHostSource, /_toolPromptSnippets/);
  assert.doesNotMatch(source, /originalRebuild\(\[\]\)/);
  assert.match(source, /originalRebuild\(activeToolNames\)/);
  assert.match(source, /readPiSessionBaseSystemPromptOptions\(session\)/);
  assert.match(source, /applyRinSystemPromptOverlay/);
});

test("runtime keeps a tool/default duplicate at the Pi-owned position", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rin-overlay-dupe-cwd-"));
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-overlay-dupe-agent-"),
  );
  const extensionDir = path.join(cwd, ".pi", "extensions");
  fs.mkdirSync(extensionDir, { recursive: true });
  fs.writeFileSync(
    path.join(extensionDir, "duplicate-guideline.mjs"),
    `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "duplicate_guideline",
    label: "Duplicate guideline",
    description: "Test duplicate guideline ownership",
    promptSnippet: "Test duplicate guideline ownership",
    promptGuidelines: ["Be concise in your responses"],
    parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "ok" }] }; }
  });
}
`,
  );
  const configured = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    noSkills: true,
    tools: ["duplicate_guideline"],
  });
  try {
    const prompt = runtimeMod.ensureSessionBaseSystemPrompt(configured.session);
    assert.equal(prompt.match(/Be concise in your responses/g)?.length, 1);
    assert.ok(
      prompt.indexOf("Be concise in your responses") <
        prompt.indexOf(
          "Do not stop after one action if the user's request obviously requires multiple concrete steps",
        ),
    );
  } finally {
    await configured.runtime.dispose();
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("user extensions receive the overlaid Rin prompt", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rin-overlay-ext-cwd-"));
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-overlay-ext-agent-"),
  );
  const extensionPath = path.join(cwd, "observe-system-prompt.mjs");
  fs.writeFileSync(
    extensionPath,
    `export default function (pi) {
  pi.on("before_agent_start", (event) => {
    if (!event.systemPrompt.startsWith("As the assistant, you must fulfill the user's requests.")) {
      throw new Error("rin_overlay_missing_before_user_extension");
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
        basePrompt,
        options,
      );
      assert.equal(
        result.systemPrompt,
        `${basePrompt}\n\nUSER EXTENSION BLOCK`,
      );
    } finally {
      await configured.runtime.dispose();
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Pi-native overlay preserves native content across six prompt scenarios", async () => {
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
    assert.doesNotMatch(prompt, /Current working directory:/);
    assert.doesNotMatch(prompt, /Current date:/);
    assert.doesNotMatch(prompt, /Preferred language:/);
  }
  assert.match(
    actual.default,
    /Use bash for file operations like ls, rg, find/,
  );
  assert.match(actual.languageAppend, /APPEND BLOCK/);
  assert.match(actual.custom, /CUSTOM BASE\n\nAPPEND BLOCK/);
  assert.match(actual.contextSkillSelf, /<project_context>/);
  assert.match(
    actual.contextSkillSelf,
    /<project_instructions path="<CWD>\/AGENTS\.md">/,
  );
  assert.match(actual.contextSkillSelf, /The following skills provide/);
  assert.match(actual.contextSkillSelf, /Stable preference\./);
  assert.match(actual.readTodo, /- todo:/);
  assert.match(actual.noTools, /Available tools:\n\(none\)/);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(actual).map(([name, prompt]) => [
        name,
        {
          hash: crypto.createHash("sha256").update(prompt).digest("hex"),
          length: prompt.length,
        },
      ]),
    ),
    NATIVE_PROMPT_BASELINE,
  );
});
