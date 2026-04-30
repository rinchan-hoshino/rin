import { BUILTIN_SLASH_COMMANDS } from "../rin-lib/rpc.js";

type SlashCommandEntry = {
  name: string;
  description: string;
  source: string;
  sourceInfo?: unknown;
};

type SlashCommandSourceGroup = {
  commands: unknown[];
  source: string;
};

type RuntimeSlashCommandCollectionOptions = {
  includeBuiltin?: boolean;
  extensionCommands?: unknown[];
  rinCapabilityCommands?: unknown[];
  promptTemplates?: unknown[];
  skills?: unknown[];
};

type OAuthCredentialSummary = {
  type: string;
};

type OAuthProviderSummary = {
  id: string;
  name: string;
  usesCallbackServer: boolean;
};

type SlashCommandCollectorSpec<T> = {
  source: unknown;
  getName: (value: T) => unknown;
  getDescription?: (value: T) => unknown;
  getSourceInfo?: (value: T) => unknown;
};

function trimText(value: unknown) {
  return String(value ?? "").trim();
}

function asArray<T>(value: unknown) {
  return Array.isArray(value) ? (value as T[]) : [];
}

function eachUniqueNormalizedValue<T>(
  values: unknown,
  normalize: (value: T) => string,
  visit: (value: T, normalized: string) => void,
) {
  const seen = new Set<string>();
  for (const value of asArray<T>(values)) {
    const normalized = normalize(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    visit(value, normalized);
  }
}

function collectSlashCommandsForSource<T>(
  values: unknown,
  spec: SlashCommandCollectorSpec<T>,
) {
  const source = trimText(spec.source);
  if (!source) return [];

  const commands: SlashCommandEntry[] = [];
  for (const value of asArray<T>(values)) {
    const name = trimText(spec.getName(value));
    if (!name) continue;
    const entry: SlashCommandEntry = {
      name,
      description: trimText(spec.getDescription?.(value)),
      source,
    };
    const sourceInfo = spec.getSourceInfo?.(value);
    if (sourceInfo !== undefined) entry.sourceInfo = sourceInfo;
    commands.push(entry);
  }
  return commands;
}

function getSkillSlashCommandName(skill: any) {
  const name = trimText(skill?.name);
  return name ? `skill:${name}` : "";
}

export function dedupeSlashCommands(commands: SlashCommandEntry[]) {
  const deduped: SlashCommandEntry[] = [];
  eachUniqueNormalizedValue<SlashCommandEntry>(
    commands,
    (command) => trimText(command?.name),
    (command) => {
      deduped.push(command);
    },
  );
  return deduped;
}

export function getBuiltinSlashCommands() {
  return collectSlashCommandsForSource<any>(BUILTIN_SLASH_COMMANDS, {
    source: "builtin",
    getName: (command) => command?.name,
    getDescription: (command) => command?.description,
  });
}

export function getExtensionSlashCommands(commands: unknown[], source: string) {
  return collectSlashCommandsForSource<any>(commands, {
    source,
    getName: (command) => command?.invocationName ?? command?.name,
    getDescription: (command) => command?.description,
    getSourceInfo: (command) => command?.sourceInfo,
  });
}

export function getPromptSlashCommands(templates: unknown[]) {
  return collectSlashCommandsForSource<any>(templates, {
    source: "prompt",
    getName: (template) => template?.name,
    getDescription: (template) => template?.description,
    getSourceInfo: (template) => template?.sourceInfo,
  });
}

export function getSkillSlashCommands(skills: unknown[]) {
  return collectSlashCommandsForSource<any>(skills, {
    source: "skill",
    getName: getSkillSlashCommandName,
    getDescription: (skill) => skill?.description,
    getSourceInfo: (skill) => skill?.sourceInfo,
  });
}

function collectSlashCommandSourceGroups(groups: unknown) {
  return asArray<SlashCommandSourceGroup>(groups).flatMap((group) =>
    getExtensionSlashCommands(group?.commands ?? [], group?.source),
  );
}

export function collectSlashCommands(
  options: {
    includeBuiltin?: boolean;
    commandGroups?: SlashCommandSourceGroup[];
    promptTemplates?: any[];
    skills?: any[];
  } = {},
) {
  return dedupeSlashCommands([
    ...(options.includeBuiltin === false ? [] : getBuiltinSlashCommands()),
    ...collectSlashCommandSourceGroups(options.commandGroups ?? []),
    ...getPromptSlashCommands(options.promptTemplates ?? []),
    ...getSkillSlashCommands(options.skills ?? []),
  ]);
}

const RUNTIME_SLASH_COMMAND_GROUP_DEFINITIONS = [
  { key: "extensionCommands", source: "extension" },
  { key: "rinCapabilityCommands", source: "rin_capability" },
] as const satisfies Array<{
  key: keyof Pick<
    RuntimeSlashCommandCollectionOptions,
    "extensionCommands" | "rinCapabilityCommands"
  >;
  source: string;
}>;

function getRuntimeSlashCommandSourceGroups(
  options: RuntimeSlashCommandCollectionOptions,
) {
  return RUNTIME_SLASH_COMMAND_GROUP_DEFINITIONS.flatMap(({ key, source }) => {
    const commands = asArray(options[key]);
    return commands.length ? [{ commands, source }] : [];
  });
}

export function collectRuntimeSlashCommands(
  options: RuntimeSlashCommandCollectionOptions = {},
) {
  return collectSlashCommands({
    includeBuiltin: options.includeBuiltin,
    commandGroups: getRuntimeSlashCommandSourceGroups(options),
    promptTemplates: options.promptTemplates ?? [],
    skills: options.skills ?? [],
  });
}

function getSessionSkills(session: any) {
  return asArray(session?.resourceLoader?.getSkills?.()?.skills);
}

export function getSessionSlashCommands(session: any) {
  return collectRuntimeSlashCommands({
    extensionCommands:
      session?.extensionRunner?.getRegisteredCommands?.() ?? [],
    promptTemplates: asArray(session?.promptTemplates),
    skills: getSessionSkills(session),
  });
}

function normalizeOAuthCredentialType(value: unknown) {
  return trimText(value);
}

function buildOAuthCredentialSummary(
  credential: any,
): OAuthCredentialSummary | undefined {
  const type = normalizeOAuthCredentialType(credential?.type);
  return type ? { type } : undefined;
}

function normalizeProviderId(value: unknown) {
  return trimText(value);
}

function buildOAuthProviderSummary(
  provider: any,
  providerId: string,
): OAuthProviderSummary {
  return {
    id: providerId,
    name: trimText(provider?.name),
    usesCallbackServer: Boolean(provider?.usesCallbackServer),
  };
}

function collectOAuthCredentials(authStorage: any) {
  const credentials: Record<string, OAuthCredentialSummary | undefined> = {};
  eachUniqueNormalizedValue<string>(
    authStorage?.list?.(),
    normalizeProviderId,
    (providerId, normalizedProviderId) => {
      credentials[normalizedProviderId] = buildOAuthCredentialSummary(
        authStorage?.get?.(providerId),
      );
    },
  );
  return credentials;
}

function collectOAuthProviders(authStorage: any) {
  const providers: OAuthProviderSummary[] = [];
  eachUniqueNormalizedValue<any>(
    authStorage?.getOAuthProviders?.(),
    (provider) => normalizeProviderId(provider?.id),
    (provider, normalizedProviderId) => {
      providers.push(buildOAuthProviderSummary(provider, normalizedProviderId));
    },
  );
  return providers;
}

export function getOAuthStateFromStorage(authStorage: any) {
  return {
    credentials: collectOAuthCredentials(authStorage),
    providers: collectOAuthProviders(authStorage),
  };
}

export function getSessionOAuthState(session: any) {
  return getOAuthStateFromStorage(session?.modelRegistry?.authStorage);
}
