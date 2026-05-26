import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { promptChatBridgeSetup } from "../chat-bridge/setup.js";
import { DEFAULT_LANGUAGE_TAG } from "../language.js";
import { BUILT_IN_RIN_EXTENSIONS } from "../rin-bundled-extensions.js";
import {
  defaultInstallDirForHome,
  installAuthPath,
  installSettingsPath,
} from "./paths.js";
import {
  configureProviderAuth,
  computeAvailableThinkingLevels,
  loadModelChoices,
} from "./provider-auth.js";
import { createInstallerI18n, type InstallerI18n } from "./i18n.js";
import {
  findDeploymentProviders,
  normalizeTargetName,
  type DeploymentProviderKind,
} from "../rin-targets/registry.js";
import type { InstallTargetSelection } from "./deployment-targets.js";
import { runInstallerProgress } from "./progress.js";

export type PromptApi = {
  ensureNotCancelled: <T>(value: T | symbol | undefined | null) => T;
  select: (options: any) => Promise<any>;
  text: (options: any) => Promise<any>;
  multiselect?: (options: any) => Promise<any>;
  confirm: (options: any) => Promise<any>;
};

export type SystemUser = {
  name: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
};

export async function promptInstallTarget(
  prompt: PromptApi,
  currentUser: string,
  allUsers: SystemUser[],
  targetHomeForUser: (user: string) => string,
  i18n: InstallerI18n = createInstallerI18n(),
): Promise<InstallTargetSelection & { cancelled?: boolean }> {
  const targetMode = prompt.ensureNotCancelled(
    await prompt.select({
      message: i18n.chooseInstallTargetMessage,
      options: [
        {
          value: "current",
          label: i18n.currentInstallTargetLabel,
          hint: currentUser,
        },
        {
          value: "local-user",
          label: i18n.localUserInstallTargetLabel,
          hint: i18n.sameMachineHint,
        },
        {
          value: "ssh",
          label: i18n.sshInstallTargetLabel,
          hint: i18n.reuseSshAuthHint,
        },
        {
          value: "container",
          label: i18n.containerInstallTargetLabel,
          hint: i18n.containerIsolationHint,
        },
        {
          value: "cloud",
          label: i18n.cloudInstallTargetLabel,
          hint: i18n.providerApiProvisionerHint,
        },
        {
          value: "vm",
          label: i18n.vmInstallTargetLabel,
          hint: i18n.hypervisorProvisionerHint,
        },
        {
          value: "nas",
          label: i18n.nasInstallTargetLabel,
          hint: i18n.nasIsolationHint,
        },
      ],
    }),
  );

  if (targetMode === "current" || targetMode === "local-user") {
    return await promptTargetInstall(
      prompt,
      currentUser,
      targetMode === "current"
        ? allUsers.filter((entry) => entry.name === currentUser)
        : allUsers.filter((entry) => entry.name !== currentUser),
      targetHomeForUser,
      i18n,
      targetMode === "current" ? "current" : "existing",
    );
  }

  if (targetMode === "ssh") {
    const host = String(
      prompt.ensureNotCancelled(
        await prompt.text({
          message: i18n.sshTargetMessage,
          placeholder: "rin-box",
          validate(value: string) {
            if (!String(value || "").trim()) return i18n.sshTargetRequired;
          },
        }),
      ),
    ).trim();
    const name = await promptTargetName(prompt, host, i18n);
    return { kind: "ssh", name, host };
  }

  if (targetMode === "container") {
    const engine = String(
      prompt.ensureNotCancelled(
        await prompt.select({
          message: i18n.containerEngineMessage,
          options: [
            { value: "docker", label: "Docker" },
            { value: "podman", label: "Podman" },
          ],
        }),
      ),
    ) as "docker" | "podman";
    const name = await promptTargetName(prompt, "rin-container", i18n);
    const image = String(
      prompt.ensureNotCancelled(
        await prompt.text({
          message: i18n.containerImageMessage,
          placeholder: "node:22-bookworm",
          defaultValue: "node:22-bookworm",
        }),
      ),
    ).trim();
    return { kind: "container", name, engine, image };
  }

  const providerKind = targetMode as DeploymentProviderKind;
  const providers = findDeploymentProviders(providerKind);
  const provider = String(
    prompt.ensureNotCancelled(
      await prompt.select({
        message: i18n.chooseDeploymentProviderMessage(providerKind),
        options: providers.map((entry) => ({
          value: entry.id,
          label: entry.label,
          hint: entry.recommendedIsolation,
        })),
      }),
    ),
  );
  const name = await promptTargetName(
    prompt,
    `${providerKind}-${provider}`,
    i18n,
  );

  if (providerKind === "cloud") {
    const defaults = cloudProviderDefaults(provider);
    const token = await promptRequiredText(
      prompt,
      `API token for ${provider}`,
      "",
    );
    const region = await promptTextWithDefault(
      prompt,
      "Region/location",
      defaults.region,
    );
    const size = await promptTextWithDefault(
      prompt,
      "Instance size",
      defaults.size,
    );
    const image = await promptTextWithDefault(prompt, "Image", defaults.image);
    return {
      kind: "cloud",
      name,
      provider,
      token,
      region,
      size,
      image,
    } as InstallTargetSelection;
  }

  if (providerKind === "nas") {
    const host = await promptRequiredText(
      prompt,
      "NAS SSH target (Host alias or user@host)",
      "nas",
    );
    const engine = String(
      prompt.ensureNotCancelled(
        await prompt.select({
          message: i18n.containerEngineMessage,
          options: [
            { value: "docker", label: "Docker" },
            { value: "podman", label: "Podman" },
          ],
        }),
      ),
    ) as "docker" | "podman";
    const image = await promptTextWithDefault(
      prompt,
      i18n.containerImageMessage,
      "node:22-bookworm",
    );
    return {
      kind: "nas",
      name,
      provider,
      host,
      engine,
      image,
    } as InstallTargetSelection;
  }

  const image = await promptTextWithDefault(prompt, "VM image", "24.04");
  return { kind: "vm", name, provider, image } as InstallTargetSelection;
}

function cloudProviderDefaults(provider: string) {
  if (provider === "hetzner") {
    return { region: "fsn1", size: "cpx11", image: "ubuntu-24.04" };
  }
  return { region: "sfo3", size: "s-1vcpu-1gb", image: "ubuntu-24-04-x64" };
}

async function promptRequiredText(
  prompt: PromptApi,
  message: string,
  placeholder: string,
) {
  return String(
    prompt.ensureNotCancelled(
      await prompt.text({
        message,
        placeholder,
        validate(value: string) {
          if (!String(value || "").trim()) return "This value is required";
        },
      }),
    ),
  ).trim();
}

async function promptTextWithDefault(
  prompt: PromptApi,
  message: string,
  defaultValue: string,
) {
  return String(
    prompt.ensureNotCancelled(
      await prompt.text({
        message,
        placeholder: defaultValue,
        defaultValue,
      }),
    ),
  ).trim();
}

async function promptTargetName(
  prompt: PromptApi,
  fallback: string,
  i18n: InstallerI18n,
) {
  const defaultName = normalizeTargetName(fallback) || "rin-target";
  return String(
    prompt.ensureNotCancelled(
      await prompt.text({
        message: i18n.targetNameMessage,
        placeholder: defaultName,
        defaultValue: defaultName,
        validate(value: string) {
          if (!normalizeTargetName(value)) return i18n.targetNameRequired;
        },
      }),
    ),
  ).trim();
}

export async function promptTargetInstall(
  prompt: PromptApi,
  currentUser: string,
  allUsers: SystemUser[],
  targetHomeForUser: (user: string) => string,
  i18n: InstallerI18n = createInstallerI18n(),
  forcedMode?: "current" | "existing" | "new",
) {
  const otherUsers = allUsers.filter((entry) => entry.name !== currentUser);
  const existingCandidates = otherUsers.length ? otherUsers : allUsers;

  const targetMode =
    forcedMode ||
    prompt.ensureNotCancelled(
      await prompt.select({
        message: i18n.chooseTargetUserMessage,
        options: [
          {
            value: "current",
            label: i18n.currentUserLabel,
            hint: currentUser,
          },
          {
            value: "existing",
            label: i18n.existingOtherUserLabel,
            hint: existingCandidates.length
              ? i18n.usersHint(existingCandidates.length)
              : i18n.noneFoundHint,
          },
          { value: "new", label: i18n.newUserLabel, hint: i18n.newUserHint },
        ],
      }),
    );

  let targetUser = currentUser;
  if (targetMode === "existing") {
    if (!existingCandidates.length) {
      return {
        kind: "local" as const,
        cancelled: true as const,
        targetUser,
        installDir: "",
        existingCandidates,
        allUsers,
      };
    }
    targetUser = prompt.ensureNotCancelled(
      await prompt.select({
        message: i18n.chooseExistingUserMessage,
        options: existingCandidates.map((entry) => ({
          value: entry.name,
          label: entry.name,
          hint: `${entry.home} · uid ${entry.uid}`,
        })),
      }),
    );
  } else if (targetMode === "new") {
    targetUser = prompt.ensureNotCancelled(
      await prompt.text({
        message: i18n.enterNewUsernameMessage,
        placeholder: i18n.usernamePlaceholder,
        validate(value: string) {
          const next = String(value || "").trim();
          if (!next) return i18n.usernameRequired;
          if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(next))
            return i18n.usernameInvalid;
        },
      }),
    );
  }

  const defaultDir = defaultInstallDirForHome(targetHomeForUser(targetUser));
  const installDir = String(
    prompt.ensureNotCancelled(
      await prompt.text({
        message: i18n.chooseInstallDirMessage,
        placeholder: defaultDir,
        defaultValue: defaultDir,
        validate(value: string) {
          const next = String(value || "").trim();
          if (!next) return i18n.directoryRequired;
          if (!path.isAbsolute(next)) return i18n.directoryMustBeAbsolute;
        },
      }),
    ),
  ).trim();

  return {
    kind: "local" as const,
    cancelled: false as const,
    targetUser,
    installDir,
    defaultDir,
    existingCandidates,
    allUsers,
  };
}

export function describeInstallDirState(
  installDir: string,
  state: { exists: boolean; entryCount: number; sample: string[] },
  i18n: InstallerI18n = createInstallerI18n(),
) {
  if (state.exists) {
    return {
      title: i18n.existingDirectoryTitle,
      text: i18n.existingDirectoryText(
        installDir,
        state.entryCount,
        state.sample,
      ),
    };
  }
  return {
    title: i18n.installDirectoryTitle,
    text: i18n.newDirectoryText(installDir),
  };
}

export async function promptDefaultTargetUser(
  prompt: PromptApi,
  targetUser: string,
  i18n: InstallerI18n = createInstallerI18n(),
) {
  return Boolean(
    prompt.ensureNotCancelled(
      await prompt.confirm({
        message: i18n.chooseDefaultTargetMessage(targetUser),
        initialValue: true,
      }),
    ),
  );
}

function normalizeRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function loadExistingProviderDefaults(
  installDir: string,
  readJsonFile: <T>(filePath: string, fallback: T) => T,
) {
  const record = normalizeRecord(
    readJsonFile<any>(installSettingsPath(installDir), {}),
  );
  const provider = String(record.defaultProvider || "").trim();
  const modelId = String(record.defaultModel || "").trim();
  const thinkingLevel = String(record.defaultThinkingLevel || "").trim();
  if (provider && modelId && thinkingLevel) {
    return { provider, modelId, thinkingLevel };
  }
  return null;
}

function hasStoredProviderAuth(authData: unknown, provider: string) {
  const record = normalizeRecord(authData);
  return Object.prototype.hasOwnProperty.call(record, provider);
}

export async function promptProviderSetup(
  prompt: PromptApi,
  installDir: string,
  readJsonFile: <T>(filePath: string, fallback: T) => T,
  deps: {
    loadModelChoices?: typeof loadModelChoices;
    configureProviderAuth?: typeof configureProviderAuth;
  } = {},
  i18n: InstallerI18n = createInstallerI18n(),
) {
  let provider = "";
  let modelId = "";
  let thinkingLevel = "";
  let authResult: any = { available: false, authKind: "pending", authData: {} };

  const loadChoices = deps.loadModelChoices || loadModelChoices;
  const configureAuth = deps.configureProviderAuth || configureProviderAuth;
  const models = await runInstallerProgress(
    i18n.loadingModelChoicesMessage,
    () => loadChoices(installDir, readJsonFile),
    {
      successMessage: i18n.installStepComplete,
      failureMessage: i18n.installStepFailed,
    },
  );
  const providerNames = [
    ...new Set(models.map((model) => model.provider).filter(Boolean)),
  ];
  if (!providerNames.length) throw new Error(i18n.noModelsAvailableError);

  const existingDefaults = loadExistingProviderDefaults(
    installDir,
    readJsonFile,
  );
  const existingAuthData = normalizeRecord(
    readJsonFile<any>(installAuthPath(installDir), {}),
  );
  if (
    existingDefaults &&
    hasStoredProviderAuth(existingAuthData, existingDefaults.provider)
  ) {
    const existingModel = models.find(
      (model) =>
        model.provider === existingDefaults.provider &&
        model.id === existingDefaults.modelId,
    );
    if (
      existingModel &&
      computeAvailableThinkingLevels(existingModel).includes(
        existingDefaults.thinkingLevel as any,
      )
    ) {
      return {
        ...existingDefaults,
        authResult: {
          available: true,
          authKind: "existing",
          authData: existingAuthData,
        },
      };
    }
  }

  provider = String(
    prompt.ensureNotCancelled(
      await prompt.select({
        message: i18n.chooseProviderMessage,
        options: providerNames.map((name) => {
          const scoped = models.filter((model) => model.provider === name);
          const availableCount = scoped.filter(
            (model) => model.available,
          ).length;
          return {
            value: name,
            label: name,
            hint: availableCount
              ? `${availableCount}/${scoped.length} ${i18n.providerReadyHint}`
              : `${scoped.length} models`,
          };
        }),
      }),
    ),
  );

  authResult = await configureAuth(String(provider), installDir, {
    readJsonFile,
    ensureNotCancelled: prompt.ensureNotCancelled,
    i18n,
  });

  const providerModels = models.filter((model) => model.provider === provider);
  if (!providerModels.length)
    throw new Error(i18n.noModelsForProviderError(provider));
  modelId = String(
    prompt.ensureNotCancelled(
      await prompt.select({
        message: i18n.chooseModelMessage,
        options: providerModels.map((model) => ({
          value: model.id,
          label: model.id,
          hint: [
            authResult.available || model.available
              ? i18n.providerReadyHint
              : i18n.providerNeedsAuthHint,
            model.reasoning ? i18n.reasoningHint : i18n.noReasoningHint,
          ].join(" · "),
        })),
      }),
    ),
  );

  const model = providerModels.find((entry) => entry.id === modelId)!;
  thinkingLevel = String(
    prompt.ensureNotCancelled(
      await prompt.select({
        message: i18n.chooseThinkingLevelMessage,
        options: computeAvailableThinkingLevels(model).map((level) => ({
          value: level,
          label: level,
        })),
      }),
    ),
  );

  return { provider, modelId, thinkingLevel, authResult };
}

export async function promptChatSetup(
  prompt: PromptApi,
  i18n: InstallerI18n = createInstallerI18n(),
) {
  const result = await promptChatBridgeSetup(prompt, {}, i18n);
  return {
    chatDescription: result.chatDescription,
    chatDetail: result.chatDetail,
    chatConfig: result.chatConfig,
  };
}

export async function promptBuiltInExtensionSetup(
  prompt: PromptApi,
  _i18n: InstallerI18n = createInstallerI18n(),
): Promise<string[]> {
  if (!prompt.multiselect) return [];
  const selected = prompt.ensureNotCancelled(
    await prompt.multiselect({
      message: "Enable optional built-in extensions",
      required: false,
      initialValues: BUILT_IN_RIN_EXTENSIONS.filter(
        (extension) => extension.defaultEnabled,
      ).map((extension) => extension.id),
      options: BUILT_IN_RIN_EXTENSIONS.map((extension) => ({
        value: extension.id,
        label: extension.label,
        hint: extension.defaultEnabled
          ? `${extension.description} Enabled by default.`
          : extension.description,
      })),
    }),
  );
  return Array.isArray(selected) ? selected.map((entry) => String(entry)) : [];
}

export function buildInstallSafetyBoundaryText(
  i18n: InstallerI18n = createInstallerI18n(),
) {
  return i18n.buildInstallSafetyBoundaryText();
}

export function buildInstallPlanText(
  options: {
    currentUser: string;
    targetUser: string;
    installDir: string;
    provider: string;
    modelId: string;
    thinkingLevel: string;
    authAvailable: boolean;
    chatDescription: string;
    chatDetail: string;
    language?: string;
    setDefaultTarget?: boolean;
  },
  i18n: InstallerI18n = createInstallerI18n(),
) {
  return i18n.buildInstallPlanText({
    targetUser: options.targetUser,
    installDir: options.installDir,
    provider: options.provider,
    modelId: options.modelId,
    thinkingLevel: options.thinkingLevel,
    authAvailable: options.authAvailable,
    chatDescription: options.chatDescription,
    chatDetail: options.chatDetail,
    language: String(options.language || i18n.language || DEFAULT_LANGUAGE_TAG),
    setDefaultTarget: options.setDefaultTarget !== false,
  });
}

function characterDisplayWidth(char: string) {
  const codePoint = char.codePointAt(0) || 0;
  if (codePoint === 0) return 0;
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (codePoint >= 0x300 && codePoint <= 0x36f) return 0;
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  ) {
    return 2;
  }
  return 1;
}

export function installerTextDisplayWidth(text: string) {
  let width = 0;
  for (const char of stripVTControlCharacters(String(text || ""))) {
    width += characterDisplayWidth(char);
  }
  return width;
}

function textDisplayWidth(text: string) {
  return installerTextDisplayWidth(text);
}

function wrapInstallerLine(line: string, maxWidth: number) {
  if (textDisplayWidth(line) <= maxWidth) return [line];
  const leading = line.match(/^\s*/)?.[0] || "";
  const bullet = line.match(/^(\s*[-*]\s+)/)?.[1] || "";
  const continuation = bullet ? " ".repeat(bullet.length) : leading;
  const rows: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const char of line) {
    const charWidth = characterDisplayWidth(char);
    if (current && currentWidth + charWidth > maxWidth) {
      rows.push(current.trimEnd());
      current = continuation;
      currentWidth = textDisplayWidth(current);
    }
    current += char;
    currentWidth += charWidth;
  }
  if (current) rows.push(current.trimEnd());
  return rows;
}

export function wrapInstallerNoteText(body: string, terminalColumns = 80) {
  const maxWidth = Math.max(40, Math.min(72, terminalColumns - 8));
  return String(body || "")
    .split("\n")
    .flatMap((line) => (line ? wrapInstallerLine(line, maxWidth) : [""]))
    .join("\n");
}

export function buildPlainInstallerSection(title: string, body: string) {
  const header = String(title || "").trim();
  const lines = String(body || "").split("\n");
  return [header, ...lines.map((line) => (line ? `  ${line}` : ""))]
    .filter((line, index) => index === 0 || line !== "")
    .join("\n");
}

export function renderInstallerNote(
  body = "",
  title = "",
  styles: {
    border?: (value: string) => string;
    body?: (value: string) => string;
    symbol?: (value: string) => string;
    title?: (value: string) => string;
  } = {},
) {
  const border = styles.border || ((value: string) => value);
  const bodyStyle = styles.body || ((value: string) => value);
  const symbol = styles.symbol || ((value: string) => value);
  const titleStyle = styles.title || ((value: string) => value);
  const rawTitle = String(title || "");
  const titleWidth = installerTextDisplayWidth(rawTitle);
  const rows = `\n${String(body || "")}\n`.split("\n");
  const contentWidth = rows.reduce(
    (max, line) => Math.max(max, installerTextDisplayWidth(line)),
    0,
  );
  const boxWidth = Math.max(contentWidth, titleWidth) + 2;
  const titleRule = "─".repeat(Math.max(boxWidth - titleWidth - 1, 1));
  const content = rows.map((line) => {
    const padding = " ".repeat(
      Math.max(boxWidth - installerTextDisplayWidth(line), 0),
    );
    return `${border("│")}  ${bodyStyle(line)}${padding}${border("│")}`;
  });
  return [
    border("│"),
    `${symbol("◇")}  ${titleStyle(rawTitle)} ${border(`${titleRule}╮`)}`,
    ...content,
    border(`├${"─".repeat(boxWidth + 2)}╯`),
  ].join("\n");
}

function pathListIncludesDir(pathList: string, dir: string) {
  const targetDir = path.resolve(dir);
  return String(pathList || "")
    .split(path.delimiter)
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .some((entry) => path.resolve(entry) === targetDir);
}

export function buildPostInstallInitExitText(
  options: {
    currentUser: string;
    targetUser: string;
    rinPath?: string;
    pathValue?: string;
  },
  i18n: InstallerI18n = createInstallerI18n(),
) {
  const rinPath = String(options.rinPath || "").trim();
  if (!rinPath) return i18n.buildPostInstallInitExitText(options);
  const launcherDir = path.dirname(rinPath);
  const launcherDirOnPath = pathListIncludesDir(
    options.pathValue ?? process.env.PATH ?? "",
    launcherDir,
  );
  return i18n.buildPostInstallInitExitText({
    ...options,
    rinCommand: launcherDirOnPath ? "rin" : rinPath,
    launcherDir,
    launcherDirOnPath,
  });
}

export function buildFinalRequirements(
  options: {
    installServiceNow: boolean;
    needsElevatedWrite: boolean;
    needsElevatedService: boolean;
  },
  i18n: InstallerI18n = createInstallerI18n(),
) {
  return i18n.buildFinalRequirements(options);
}
