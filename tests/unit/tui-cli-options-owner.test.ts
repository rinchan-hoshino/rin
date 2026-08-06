import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const cliOptions = await importBuiltModule<
  typeof import("../../src/core/rin-tui/cli-options.js")
>("dist/core/rin-tui/cli-options.js");

test("TUI CLI options own Rin resources, Pi passthrough, extensions, and messages", () => {
  const cwd = "/tmp/rin-tui-cli-owner";
  const parsed = cliOptions.parseTuiCliOptions(
    [
      "first message",
      "--verbose",
      "--extension",
      "extensions/local",
      "-e",
      "npm:@owner/extension",
      "--extension=git:https://example.com/extension.git",
      "--extension=",
      "--no-extensions",
      "--skill",
      "skills/local",
      "--skill=https://example.com/skill",
      "--no-skills",
      "--prompt-template",
      "prompts/default.md",
      "--prompt-template=~/prompts/owner.md",
      "--no-prompt-templates",
      "--theme",
      "themes/owner.json",
      "--theme=ssh:owner/theme",
      "--no-themes",
      "--no-context-files",
      "--system-prompt",
      "owner system",
      "--system-prompt=owner override",
      "--tools",
      "read, bash,read",
      "--tools=edit,write",
      "--exclude-tools",
      "browser, search",
      "--exclude-tools=agents",
      "--no-tools",
      "--no-builtin-tools",
      "--name",
      " first name ",
      "--name=second name",
      "-n= final name ",
      "--provider",
      "openai",
      "--model=gpt-owner",
      "--thinking",
      "high",
      "--print",
      "--list-models",
      "openai",
      "--owner-mode=careful",
      "--owner-toggle",
      "--owner-value",
      "enabled",
      "-z",
      "--",
      "--literal-message",
      "second message",
    ],
    cwd,
  );

  assert.equal(parsed.initialMessage, "first message");
  assert.deepEqual(parsed.initialMessages, [
    "--literal-message",
    "second message",
  ]);
  assert.equal(parsed.verbose, true);
  assert.equal(parsed.sessionName, "final name");
  assert.deepEqual(parsed.resources.additionalExtensionPaths, [
    path.resolve(cwd, "extensions/local"),
    "npm:@owner/extension",
    "git:https://example.com/extension.git",
  ]);
  assert.deepEqual(parsed.resources.additionalSkillPaths, [
    path.resolve(cwd, "skills/local"),
    "https://example.com/skill",
  ]);
  assert.deepEqual(parsed.resources.additionalPromptTemplatePaths, [
    path.resolve(cwd, "prompts/default.md"),
    "~/prompts/owner.md",
  ]);
  assert.deepEqual(parsed.resources.additionalThemePaths, [
    path.resolve(cwd, "themes/owner.json"),
    "ssh:owner/theme",
  ]);
  assert.equal(parsed.resources.noExtensions, true);
  assert.equal(parsed.resources.noSkills, true);
  assert.equal(parsed.resources.noPromptTemplates, true);
  assert.equal(parsed.resources.noThemes, true);
  assert.equal(parsed.resources.noContextFiles, true);
  assert.equal(parsed.resources.systemPrompt, "owner override");
  assert.deepEqual(parsed.resources.tools, ["edit", "write"]);
  assert.deepEqual(parsed.resources.excludeTools, ["agents"]);
  assert.equal(parsed.resources.noTools, "builtin");
  assert.deepEqual(
    Object.fromEntries(parsed.resources.extensionFlagValues ?? []),
    {
      "owner-mode": "careful",
      "owner-toggle": true,
      "owner-value": "enabled",
    },
  );
  assert.equal((parsed.resources.piStartupOptions as any).provider, "openai");
  assert.equal((parsed.resources.piStartupOptions as any).model, "gpt-owner");
});

test("TUI CLI options own empty, missing-value, optional-value, and compatibility forms", () => {
  const cwd = "/tmp/rin-tui-cli-owner-empty";
  const empty = cliOptions.parseTuiCliOptions([], cwd);
  assert.equal(empty.initialMessage, undefined);
  assert.equal(empty.initialMessages, undefined);
  assert.equal(empty.verbose, undefined);
  assert.equal(empty.sessionName, undefined);
  assert.deepEqual(empty.resources.additionalExtensionPaths, []);

  const missing = cliOptions.parseTuiCliOptions(
    [
      "",
      "--extension",
      "--skill",
      "--prompt-template",
      "--theme",
      "--system-prompt",
      "--tools",
      "--exclude-tools",
      "--name",
      "--provider",
      "--model",
      "--list-models",
      "@owner/*",
      "--list-models=@owner/*",
      "--feature",
      "@literal",
      "-n",
      "ignored-short",
    ],
    cwd,
  );
  assert.deepEqual(missing.resources.additionalExtensionPaths, []);
  assert.deepEqual(missing.resources.additionalSkillPaths, []);
  assert.deepEqual(missing.resources.additionalPromptTemplatePaths, []);
  assert.deepEqual(missing.resources.additionalThemePaths, []);
  assert.equal(missing.resources.systemPrompt, undefined);
  assert.equal(missing.resources.tools, undefined);
  assert.equal(missing.resources.excludeTools, undefined);
  assert.equal(missing.sessionName, "ignored-short");
  assert.equal(missing.resources.extensionFlagValues?.get("feature"), true);
  assert.equal(missing.initialMessage, "@owner/*");
  assert.deepEqual(missing.initialMessages, ["@literal"]);

  const compatibility = cliOptions.parseTuiCliOptions(
    [
      "--mode=rpc",
      "--provider=openai",
      "--model=gpt-owner",
      "--thinking=medium",
      "--session=owner-session",
      "--tools=read,bash",
      "--exclude-tools=agents",
      "--no-tools",
      "message",
    ],
    cwd,
  );
  assert.equal(compatibility.initialMessage, "message");
  assert.equal((compatibility.resources.piStartupOptions as any).mode, "rpc");
  assert.deepEqual(compatibility.resources.tools, ["read", "bash"]);
  assert.deepEqual(compatibility.resources.excludeTools, ["agents"]);
  assert.equal(compatibility.resources.noTools, "all");
});
