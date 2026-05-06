import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const helperModule = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-daemon", "catalog-helpers.js"),
  ).href
);

const {
  collectRuntimeSlashCommands,
  collectSlashCommands,
  dedupeSlashCommands,
  getExtensionSlashCommands,
  getOAuthStateFromModelRegistry,
  getOAuthStateFromStorage,
  getPromptSlashCommands,
  getSkillSlashCommands,
} = helperModule;

test("catalog helpers normalize direct slash-command collectors consistently", () => {
  assert.deepEqual(
    getExtensionSlashCommands(
      [
        {
          invocationName: "  inspect  ",
          description: "  Inspect chat state.  ",
          sourceInfo: { file: "extension-a" },
        },
        {
          name: "fallback-name",
          description: "  Fallback when invocationName is missing.  ",
        },
        {
          invocationName: "   ",
          name: "ignored",
        },
      ],
      " extension ",
    ),
    [
      {
        name: "inspect",
        description: "Inspect chat state.",
        source: "extension",
        sourceInfo: { file: "extension-a" },
      },
      {
        name: "fallback-name",
        description: "Fallback when invocationName is missing.",
        source: "extension",
      },
    ],
  );

  assert.deepEqual(
    getPromptSlashCommands([
      {
        name: "  polish  ",
        description: "  Rewrite the final reply.  ",
        sourceInfo: { file: "prompt-a" },
      },
    ]),
    [
      {
        name: "polish",
        description: "Rewrite the final reply.",
        source: "prompt",
        sourceInfo: { file: "prompt-a" },
      },
    ],
  );

  assert.deepEqual(
    getSkillSlashCommands([
      {
        name: "  cleanup  ",
        description: "  Remove stale files.  ",
        sourceInfo: { file: "skill-a" },
      },
      {
        name: "   ",
        description: "ignored",
      },
    ]),
    [
      {
        name: "skill:cleanup",
        description: "Remove stale files.",
        source: "skill",
        sourceInfo: { file: "skill-a" },
      },
    ],
  );
});

test("catalog helpers normalize and dedupe slash commands", () => {
  const commands = collectSlashCommands({
    includeBuiltin: false,
    commandGroups: [
      {
        source: " extension ",
        commands: [
          {
            invocationName: "  resume  ",
            description: "  Resume a session.  ",
            sourceInfo: { file: "extension-a" },
          },
          {
            name: "resume",
            description: "duplicate entry should be ignored",
          },
        ],
      },
      {
        source: "   ",
        commands: [{ name: "ignored", description: "missing source" }],
      },
    ],
    promptTemplates: [
      {
        name: "  polish  ",
        description: "  Rewrite the final reply.  ",
        sourceInfo: { file: "prompt-a" },
      },
    ],
    skills: [
      {
        name: "  cleanup  ",
        description: "  Remove stale files.  ",
        sourceInfo: { file: "skill-a" },
      },
      {
        name: "   ",
        description: "ignored",
      },
    ],
  });

  assert.deepEqual(commands, [
    {
      name: "resume",
      description: "Resume a session.",
      source: "extension",
      sourceInfo: { file: "extension-a" },
    },
    {
      name: "polish",
      description: "Rewrite the final reply.",
      source: "prompt",
      sourceInfo: { file: "prompt-a" },
    },
    {
      name: "skill:cleanup",
      description: "Remove stale files.",
      source: "skill",
      sourceInfo: { file: "skill-a" },
    },
  ]);

  assert.deepEqual(
    dedupeSlashCommands([
      { name: " resume ", description: "first", source: "extension" },
      { name: "resume", description: "second", source: "prompt" },
      { name: "   ", description: "ignored", source: "skill" },
    ]),
    [{ name: " resume ", description: "first", source: "extension" }],
  );
});

test("catalog helpers collect runtime slash commands in source order", () => {
  const commands = collectRuntimeSlashCommands({
    rinCapabilityCommands: [
      {
        invocationName: "  inspect  ",
        description: "  Inspect chat state.  ",
      },
    ],
  });

  const inspectCommand = commands.find((command) => command.name === "inspect");
  assert.deepEqual(inspectCommand, {
    name: "inspect",
    description: "Inspect chat state.",
    source: "rin_capability",
  });
  assert.equal(
    commands.some((command) => command.name === "model"),
    true,
  );
});

function createCatalogAuthStorage() {
  return {
    list: () => [" gemini ", "missing", "", "gemini"],
    get: (providerId) => {
      const normalized = String(providerId).trim();
      if (normalized === "gemini") return { type: " api_key ", key: "secret" };
      return null;
    },
    getOAuthProviders: () => [
      {
        id: "gemini",
        name: "Gemini",
        usesCallbackServer: 1,
      },
      {
        id: " gemini ",
        name: "Duplicate",
        usesCallbackServer: 0,
      },
      {
        id: " ",
        name: "Ignored",
        usesCallbackServer: 1,
      },
    ],
  };
}

test("catalog helpers read oauth state from auth storage", () => {
  const state = getOAuthStateFromStorage(createCatalogAuthStorage());

  assert.deepEqual(state, {
    credentials: {
      gemini: { type: "api_key" },
      missing: undefined,
    },
    providers: [
      {
        id: "gemini",
        name: "Gemini",
        usesCallbackServer: true,
      },
    ],
  });
});

test("catalog helpers include backend provider display names and auth status", () => {
  const state = getOAuthStateFromModelRegistry({
    authStorage: createCatalogAuthStorage(),
    getAll: () => [
      { provider: "gemini", id: "gemini-pro" },
      { provider: "openai", id: "gpt-5" },
    ],
    getProviderDisplayName(providerId) {
      return providerId === "openai" ? "OpenAI" : "Google Gemini";
    },
    getProviderAuthStatus(providerId) {
      if (providerId === "openai") {
        return {
          configured: true,
          source: "environment",
          label: "OPENAI_API_KEY",
        };
      }
      if (providerId === "gemini") {
        return { configured: true, source: "api_key" };
      }
      return { configured: false };
    },
  });

  assert.deepEqual(state.providerDisplayNames, {
    gemini: "Google Gemini",
    missing: "Google Gemini",
    openai: "OpenAI",
  });
  assert.deepEqual(state.providerAuthStatuses, {
    gemini: { configured: true, source: "api_key" },
    openai: {
      configured: true,
      source: "environment",
      label: "OPENAI_API_KEY",
    },
  });
});
