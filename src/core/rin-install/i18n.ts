import {
  DEFAULT_LANGUAGE_TAG,
  detectLocalLanguageTag,
  normalizeLanguageTag,
  resolveInstallerDisplayLanguage,
  type InstallerDisplayLanguage,
} from "../language.js";

export type InstallerI18n = ReturnType<typeof createInstallerI18n>;

type InstallerLanguagePromptApi = {
  ensureNotCancelled: <T>(value: T | symbol | undefined | null) => T;
  select: (options: any) => Promise<any>;
  text: (options: any) => Promise<any>;
};

const LANGUAGE_OPTIONS = [
  { value: DEFAULT_LANGUAGE_TAG, label: "English", hint: DEFAULT_LANGUAGE_TAG },
  { value: "zh_CN", label: "简体中文", hint: "zh_CN" },
  { value: "zh_TW", label: "繁體中文", hint: "zh_TW" },
  { value: "ja_JP", label: "日本語", hint: "ja_JP" },
  { value: "ko_KR", label: "한국어", hint: "ko_KR" },
  { value: "fr_FR", label: "Français", hint: "fr_FR" },
  { value: "es_ES", label: "Español", hint: "es_ES" },
  { value: "de_DE", label: "Deutsch", hint: "de_DE" },
  { value: "pt_BR", label: "Português (Brasil)", hint: "pt_BR" },
  { value: "ru_RU", label: "Русский", hint: "ru_RU" },
  { value: "ar_SA", label: "العربية", hint: "ar_SA" },
  { value: "hi_IN", label: "हिन्दी", hint: "hi_IN" },
  { value: "custom", label: "Other", hint: "Enter any locale code" },
] as const;

type InstallerLanguagePromptCopy = {
  chooseMessage: string;
  detectedSuffix: string;
  customLabel: string;
  customHint: string;
  textMessage: string;
  invalidLanguageTag: string;
};

type ChatCommandDescriptions = Record<
  "help" | "abort" | "new" | "compact" | "reload" | "usage",
  string
>;

type ChatRuntimeCopy = {
  working: {
    frames: string[];
  };
  telegramWorking: {
    workingInitial: string;
    workingSuffix: string;
    thinkingInitial: string;
    thinkingSuffix: string;
    separator: string;
    prompts: string[];
  };
};

type InstallerDisplayCopy = {
  languagePrompt: InstallerLanguagePromptCopy;
  chatCommandDescriptions: ChatCommandDescriptions;
  chatRuntime: ChatRuntimeCopy;
  installerCancelled: string;
  introTitle: string;
  safetyBoundaryTitle: string;
  targetUserTitle: string;
  installChoicesTitle: string;
  ownershipCheckTitle: string;
  writtenPathsTitle: string;
  targetInstallDirLabel: string;
  writtenPathLabel: string;
  serviceLabelLabel: string;
  launchingInitTitle: string;
  afterInitTitle: string;
  confirmActiveLabel: string;
  confirmInactiveLabel: string;
  existingDirectoryTitle: string;
  installDirectoryTitle: string;
  currentUserLabel: string;
  existingOtherUserLabel: string;
  newUserLabel: string;
  chooseInstallTargetMessage: string;
  currentInstallTargetLabel: string;
  localUserInstallTargetLabel: string;
  sshInstallTargetLabel: string;
  containerInstallTargetLabel: string;
  cloudInstallTargetLabel: string;
  vmInstallTargetLabel: string;
  nasInstallTargetLabel: string;
  sameMachineHint: string;
  reuseSshAuthHint: string;
  containerIsolationHint: string;
  providerApiProvisionerHint: string;
  hypervisorProvisionerHint: string;
  nasIsolationHint: string;
  sshTargetMessage: string;
  sshTargetRequired: string;
  targetNameMessage: string;
  targetNameRequired: string;
  containerEngineMessage: string;
  containerImageMessage: string;
  chooseDeploymentProviderMessage: (kind: string) => string;
  noneFoundHint: string;
  usersHint: (count: number) => string;
  newUserHint: string;
  existingDirectoryText: (
    installDir: string,
    entryCount: number,
    sample: string[],
  ) => string;
  newDirectoryText: (installDir: string) => string;
  chooseTargetUserMessage: string;
  chooseExistingUserMessage: string;
  enterNewUsernameMessage: string;
  usernamePlaceholder: string;
  usernameRequired: string;
  usernameInvalid: string;
  chooseDefaultTargetMessage: (targetUser: string) => string;
  defaultTargetLabel: string;
  defaultTargetSetValue: (targetUser: string) => string;
  defaultTargetSkippedValue: string;
  chooseProviderMessage: string;
  chooseModelMessage: string;
  chooseThinkingLevelMessage: string;
  providerReadyHint: string;
  providerNeedsAuthHint: string;
  subscriptionAuthLabel: string;
  apiAuthLabel: string;
  modelCountLabel: (count: number) => string;
  reasoningHint: string;
  noReasoningHint: string;
  noModelsAvailableError: string;
  noModelsForProviderError: (provider: string) => string;
  fieldRequired: string;
  valueRequired: string;
  validUrlRequired: string;
  installSafetyBoundaryLines: string[];
  buildInstallSafetyBoundaryText: (this: InstallerDisplayCopy) => string;
  buildInstallPlanText: (
    this: InstallerDisplayCopy,
    options: {
      targetUser: string;
      installDir: string;
      provider: string;
      modelId: string;
      thinkingLevel: string;
      authAvailable: boolean;
      language: string;
      setDefaultTarget: boolean;
    },
  ) => string;
  updaterIntroTitle: string;
  updateTargetsTitle: string;
  updatePlanTitle: string;
  updatingTargetTitle: string;
  updatedTargetTitle: string;
  chooseUpdateTargetMessage: string;
  noUpdateTargetsText: string;
  updaterNothingUpdated: string;
  updaterFinishedWithoutWritingChanges: string;
  updateAlreadyCurrentTitle: string;
  fetchAndApplyUpdateConfirmMessage: string;
  publishUpdateConfirmMessage: string;
  publishingUpdateMessage: string;
  fetchingUpdateSourceMessage: string;
  preparingUpdateSourceMessage: string;
  installingUpdateDependenciesMessage: string;
  buildingUpdateRuntimeMessage: string;
  pruningUpdateDependenciesMessage: string;
  buildUpdateCommandFailureHeader: (label: string) => string;
  formatUpdateDiscoverySource: (source: string) => string;
  formatUpdateSourceLabel: (sourceLabel: string) => string;
  formatUpdateServiceHint: (serviceHint: string) => string;
  buildUpdateTargetText: (options: {
    currentUser: string;
    targetUser: string;
    installDir: string;
    source: string;
    ownerHome: string;
  }) => string;
  buildUpdatePlanText: (options: {
    currentUser: string;
    targetUser: string;
    installDir: string;
    source: string;
    ownerHome: string;
    sourceLabel: string;
  }) => string;
  buildUpdateAlreadyCurrentText: (options: {
    installDir: string;
    sourceLabel: string;
  }) => string;
  buildUpdatedTargetText: (options: {
    installDir: string;
    writtenPaths: string[];
    prunedReleaseCount: number;
    serviceKind?: string;
    serviceLabel?: string;
  }) => string;
  buildAfterUpdateText: (options: {
    serviceHint: string;
    daemonReady: boolean;
    userSuffix: string;
  }) => string;
  updaterOutroUpdated: (
    targetUser: string,
    installDir: string,
    daemonReady: boolean,
    userSuffix: string,
  ) => string;
  buildPostInstallInitExitText: (options: {
    currentUser: string;
    targetUser: string;
    rinCommand?: string;
    launcherDir?: string;
    launcherDirOnPath?: boolean;
  }) => string;
  buildFinalRequirements: (options: {
    installServiceNow: boolean;
    needsElevatedWrite: boolean;
    needsElevatedService: boolean;
  }) => string[];
  finalizeInstallationMessage: (finalRequirements: string[]) => string;
  noEligibleUsersText: (currentUser: string, visibleUsers: string[]) => string;
  nothingInstalled: string;
  installerFinishedWithoutWritingChanges: string;
  ownershipMismatchText: (ownership: {
    statUid: number;
    statGid: number;
    targetUid: number;
    targetGid: number;
  }) => string;
  ownershipNotWritableText: string;
  preparingInstallerMessage: string;
  applyingTargetSelectionMessage: string;
  inspectingInstallDirectoryMessage: string;
  loadingModelChoicesMessage: string;
  savingProviderAuthMessage: string;
  refreshingInstalledTargetMessage: string;
  publishingRuntimeMessageElevated: string;
  publishingRuntimeMessage: string;
  launchingInitText: string;
  outroInstalled: (
    targetUser: string,
    installedServiceKind?: string,
    options?: {
      openCommand?: string;
      immediateCommand?: string;
      launcherDir?: string;
      launcherDirOnPath?: boolean;
    },
  ) => string;
  installStepFailed: string;
  installStepComplete: string;
  startingLogin: (providerName: string) => string;
  openUrlToContinueLogin: (url: string, instructions?: string) => string;
  deviceCodeLoginInstructions: (userCode: string) => string;
  enterLoginValueMessage: string;
  waitingForLogin: (providerName: string) => string;
  manualCodeInputMessage: string;
  manualCodePlaceholder: (lastAuthUrl: string) => string;
  loginComplete: (providerName: string) => string;
  loginFailed: (providerName: string) => string;
  enterApiKeyMessage: (providerName: string) => string;
  tokenRequired: string;
};

const INSTALLER_DISPLAY_COPY = {
  en_US: {
    languagePrompt: {
      chooseMessage: "Choose installer language",
      detectedSuffix: "detected",
      customLabel: "Other",
      customHint: "Enter any locale code",
      textMessage: "Enter locale code",
      invalidLanguageTag: "Use a valid locale code such as en_US",
    },
    chatCommandDescriptions: {
      help: "Show available commands",
      abort: "Abort current operation",
      new: "Start a new session",
      compact: "Compact the current session",
      reload: "Reload extensions, prompts, skills, and themes",
      usage: "Show usage and quota status",
    },
    chatRuntime: {
      working: {
        frames: ["Working...", "Working", "Working.", "Working.."],
      },
      telegramWorking: {
        workingInitial: "Working...",
        workingSuffix: "Working",
        thinkingInitial: "Working...",
        thinkingSuffix: "Working",
        separator: "-----------",
        prompts: [
          "Working on it (๑•̀ㅂ•́)و✧",
          "Organizing things (｡･ω･｡)",
          "Processing details (つω`｡)",
          "Sorting information (ﾉ◕ヮ◕)ﾉ*:･ﾟ✧",
          "Almost there, still working (ง •̀_•́)ง",
          "Working, please wait (｀・ω・´)",
        ],
      },
    },
    installerCancelled: "Installer cancelled.",
    introTitle: "Rin Installer",
    safetyBoundaryTitle: "Safety boundary",
    targetUserTitle: "Target user",
    installChoicesTitle: "Install choices",
    ownershipCheckTitle: "Ownership check",
    writtenPathsTitle: "Written paths",
    targetInstallDirLabel: "Rin home",
    writtenPathLabel: "Written",
    serviceLabelLabel: "label",
    launchingInitTitle: "Launching init",
    afterInitTitle: "After init",
    confirmActiveLabel: "Yes",
    confirmInactiveLabel: "No",
    existingDirectoryTitle: "Existing directory",
    installDirectoryTitle: "Local Rin config",
    currentUserLabel: "Current user",
    existingOtherUserLabel: "Existing other user",
    newUserLabel: "New user",
    chooseInstallTargetMessage: "Where should Rin be installed?",
    currentInstallTargetLabel: "This user",
    localUserInstallTargetLabel: "Another local user",
    sshInstallTargetLabel: "Existing SSH host",
    containerInstallTargetLabel: "Local container",
    cloudInstallTargetLabel: "New cloud instance",
    vmInstallTargetLabel: "New virtual machine",
    nasInstallTargetLabel: "NAS isolated runtime",
    sameMachineHint: "same machine",
    reuseSshAuthHint: "reuse your ssh config/auth",
    containerIsolationHint: "Docker or Podman isolation",
    providerApiProvisionerHint: "provider API provisioner",
    hypervisorProvisionerHint: "hypervisor provisioner",
    nasIsolationHint: "vendor app/container runtime",
    sshTargetMessage: "SSH target (Host alias or user@host)",
    sshTargetRequired: "SSH target is required",
    targetNameMessage: "Target name for future rin --target use",
    targetNameRequired: "Target name is required",
    containerEngineMessage: "Container engine",
    containerImageMessage: "Base image",
    chooseDeploymentProviderMessage: (kind: string) =>
      `Choose ${kind} provider`,
    noneFoundHint: "none found",
    usersHint: (count: number) => `${count} user(s)`,
    newUserHint: "enter a username",
    existingDirectoryText(
      installDir: string,
      entryCount: number,
      sample: string[],
    ) {
      return [
        `Path exists: ${installDir}`,
        `Existing entries: ${entryCount}`,
        sample.length ? `Sample: ${sample.join(", ")}` : "",
        "",
        "Installer policy:",
        "- keep unknown files untouched",
        "- keep existing config unless a required file must be updated",
        "- only remove old files when they are known legacy Rin artifacts",
      ]
        .filter(Boolean)
        .join("\n");
    },
    newDirectoryText: (installDir: string) =>
      [
        `Local Rin config will be created: ${installDir}`,
        "",
        "Installer policy:",
        "- create only the files Rin needs",
        "- future updates should preserve unknown files",
      ].join("\n"),
    chooseTargetUserMessage: "Choose the target user for the Rin daemon.",
    chooseExistingUserMessage:
      "Choose the existing user to host the Rin daemon.",
    enterNewUsernameMessage:
      "Enter the new username to create for the Rin daemon.",
    usernamePlaceholder: "rin",
    usernameRequired: "Username is required.",
    usernameInvalid: "Use a normal Unix username.",
    chooseDefaultTargetMessage: (targetUser: string) =>
      `Set ${targetUser} as the default target user for future rin / rin update runs from this launcher user?`,
    defaultTargetLabel: "Default target user",
    defaultTargetSetValue: (targetUser: string) => `set to ${targetUser}`,
    defaultTargetSkippedValue: "not set",
    chooseProviderMessage: "Choose a provider to authenticate and use.",
    chooseModelMessage: "Choose a model.",
    chooseThinkingLevelMessage: "Choose the default thinking level.",
    providerReadyHint: "ready",
    providerNeedsAuthHint: "needs auth/config",
    subscriptionAuthLabel: "Subscription",
    apiAuthLabel: "API",
    modelCountLabel: (count: number) =>
      `${count} ${count === 1 ? "model" : "models"}`,
    reasoningHint: "reasoning",
    noReasoningHint: "no reasoning",
    noModelsAvailableError: "rin_installer_no_models_available",
    noModelsForProviderError: (provider: string) =>
      `rin_installer_no_models_for_provider:${provider}`,
    fieldRequired: "This field is required.",
    valueRequired: "A value is required.",
    validUrlRequired: "Use a valid URL.",
    installSafetyBoundaryLines: [
      "Rin safety boundary:",
      "- Rin always runs in YOLO mode.",
      "- There is no sandbox for shell/file actions.",
      "- Rin acts with the full user-level permissions of the selected system account.",
      "- It may read files, modify files, run commands, and access network resources available to that account.",
      "- Prompts, tool outputs, file contents, memory context, and search results may be sent to the active model/provider, so sensitive data may be exposed.",
      "",
      "Possible extra token overhead beyond your visible chat turns:",
      "- memory prompt blocks injected into normal turns",
      "- the first-run initialization turn",
      "- memory extraction during session shutdown or `/new` handoff",
      "- episode synthesis during session shutdown or `/new` handoff",
      "- context compaction / summarization when the session grows large",
      "- non-interactive `rin -p` / `rin --mode json` turns when the assistant or a script delegates work",
      "- scheduled task / chat-bridge-triggered agent runs that create their own turns",
      "- browse result text added into the model context when search is used",
    ],
    buildInstallSafetyBoundaryText() {
      return this.installSafetyBoundaryLines.join("\n");
    },
    buildInstallPlanText(options) {
      const skippedForNow = "skipped for now";
      const authStatus = options.provider
        ? options.authAvailable
          ? "ready"
          : "needs auth/config later"
        : skippedForNow;
      return [
        `Target daemon user: ${options.targetUser}`,
        `Rin home: ${options.installDir}`,
        `Language: ${options.language}`,
        `Provider: ${options.provider || skippedForNow}`,
        `Model: ${options.modelId || skippedForNow}`,
        `Thinking level: ${options.thinkingLevel || skippedForNow}`,
        `Model auth status: ${authStatus}`,
        `${this.defaultTargetLabel}: ${options.setDefaultTarget ? this.defaultTargetSetValue(options.targetUser) : this.defaultTargetSkippedValue}`,
      ]
        .filter(Boolean)
        .join("\n");
    },
    updaterIntroTitle: "Rin Updater",
    updateTargetsTitle: "Update targets",
    updatePlanTitle: "Update plan",
    updatingTargetTitle: "Applying update",
    updatedTargetTitle: "Updated target",
    chooseUpdateTargetMessage: "Choose an installed Rin target to update.",
    noUpdateTargetsText:
      "No installed Rin daemon targets were discovered on this system.",
    updaterNothingUpdated: "Nothing updated.",
    updaterFinishedWithoutWritingChanges:
      "Updater finished without writing changes.",
    updateAlreadyCurrentTitle: "Already up to date",
    fetchAndApplyUpdateConfirmMessage: "Fetch and apply this update now?",
    publishUpdateConfirmMessage:
      "Publish the prepared runtime to this installed target now?",
    publishingUpdateMessage:
      "Publishing runtime and refreshing the installed target...",
    fetchingUpdateSourceMessage: "Fetching update source",
    preparingUpdateSourceMessage: "Preparing update source",
    installingUpdateDependenciesMessage: "Installing update dependencies",
    buildingUpdateRuntimeMessage: "Building update runtime",
    pruningUpdateDependenciesMessage: "Pruning update dependencies",
    buildUpdateCommandFailureHeader: (label: string) =>
      `${label} failed; recent log:`,
    formatUpdateDiscoverySource: (source: string) => source,
    formatUpdateSourceLabel: (sourceLabel: string) => sourceLabel,
    formatUpdateServiceHint: (serviceHint: string) => serviceHint,
    buildUpdateTargetText(options) {
      return [
        `Current user: ${options.currentUser}`,
        `Selected daemon user: ${options.targetUser}`,
        `${this.targetInstallDirLabel}: ${options.installDir}`,
        `Discovered from: ${this.formatUpdateDiscoverySource(options.source)}`,
        `Owner home: ${options.ownerHome}`,
      ].join("\n");
    },
    buildUpdatePlanText(options) {
      return [
        `Current user: ${options.currentUser}`,
        `Selected daemon user: ${options.targetUser}`,
        `Rin home: ${options.installDir}`,
        `Discovered from: ${this.formatUpdateDiscoverySource(options.source)}`,
        `Owner home: ${options.ownerHome}`,
        `Requested source: ${this.formatUpdateSourceLabel(options.sourceLabel)}`,
        "",
        "Updater policy:",
        "- publish a new runtime release into the existing Rin home",
        "- prune old runtime releases and keep only the 3 most recent ones",
        "- refresh launchers and installer metadata for the current user",
        "- refresh managed daemon service files and restart the daemon when applicable",
        "- preserve existing provider/auth/settings unless changed elsewhere",
      ].join("\n");
    },
    buildUpdateAlreadyCurrentText(options) {
      return [
        `${this.targetInstallDirLabel}: ${options.installDir}`,
        `Current source: ${this.formatUpdateSourceLabel(options.sourceLabel)}`,
        "No download or runtime changes are needed.",
      ].join("\n");
    },
    buildUpdatedTargetText(options) {
      return [
        `${this.targetInstallDirLabel}: ${options.installDir}`,
        ...options.writtenPaths.map(
          (item) => `${this.writtenPathLabel}: ${item}`,
        ),
        `Removed old releases: ${options.prunedReleaseCount}`,
        options.serviceKind && options.serviceLabel
          ? `${options.serviceKind} ${this.serviceLabelLabel}: ${options.serviceLabel}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    },
    buildAfterUpdateText(options) {
      return [
        `Service/platform note: ${this.formatUpdateServiceHint(options.serviceHint)}`,
        `Daemon started now: ${options.daemonReady ? "yes" : "no"}`,
        "",
        "Recommended next commands:",
        `- doctor: rin doctor${options.userSuffix}`,
        `- open Rin: rin${options.userSuffix}`,
        "- if RPC mode fails, run `rin doctor` or reopen Rin to enter temporary maintenance mode",
      ].join("\n");
    },
    updaterOutroUpdated(targetUser, installDir, daemonReady, userSuffix) {
      return `Updater refreshed ${targetUser} at ${installDir}. ${daemonReady ? `Open with rin${userSuffix}.` : `Use rin start${userSuffix} if you need to start the daemon manually.`}`;
    },
    buildPostInstallInitExitText(options) {
      const rinCommand = options.rinCommand || "rin";
      const userSuffix =
        options.currentUser === options.targetUser
          ? ""
          : ` -u ${options.targetUser}`;
      return [
        "Initialization TUI exited.",
        "",
        "Next time:",
        `- open Rin: ${rinCommand}${userSuffix}`,
        `- check daemon state if needed: ${rinCommand} doctor${userSuffix}`,
        "- restart initialization only after an agent resets the initialization completed state",
      ].join("\n");
    },
    buildFinalRequirements(options) {
      return [
        "write configuration and launchers",
        "publish the runtime into Rin home",
        options.installServiceNow
          ? "install and start the daemon service"
          : "skip daemon service installation on this platform",
        options.needsElevatedWrite || options.needsElevatedService
          ? "use sudo/doas if needed for the selected target and Rin home"
          : "no extra privilege escalation currently predicted",
      ];
    },
    finalizeInstallationMessage: (finalRequirements: string[]) =>
      [
        "Finalize installation now?",
        ...finalRequirements.map((item) => `- ${item}`),
      ].join("\n"),
    noEligibleUsersText: (currentUser: string, visibleUsers: string[]) =>
      [
        "No eligible existing users were found on this system.",
        `Detected current user: ${currentUser}`,
        `Visible users: ${visibleUsers.join(", ") || "none"}`,
      ].join("\n"),
    nothingInstalled: "Nothing installed.",
    installerFinishedWithoutWritingChanges:
      "Installer finished without writing changes.",
    ownershipMismatchText(ownership) {
      return [
        `Target dir owner uid/gid: ${ownership.statUid}:${ownership.statGid}`,
        `Target user uid/gid: ${ownership.targetUid}:${ownership.targetGid}`,
        "This directory is not currently owned by the selected target user.",
        "The installer will still write config if it can, but you may want to fix ownership before switching fully.",
      ].join("\n");
    },
    ownershipNotWritableText:
      "The default local Rin directory is not writable by the current installer process.",
    preparingInstallerMessage: "Preparing installer context...",
    applyingTargetSelectionMessage: "Applying target selection...",
    inspectingInstallDirectoryMessage: "Checking local Rin config...",
    loadingModelChoicesMessage: "Loading model and provider state...",
    savingProviderAuthMessage: "Saving provider authentication...",
    refreshingInstalledTargetMessage:
      "Publishing runtime and refreshing the installed target...",
    publishingRuntimeMessageElevated:
      "Publishing runtime and writing configuration with elevated permissions...",
    publishingRuntimeMessage: "Publishing runtime and writing configuration...",
    launchingInitText: [
      "Installation is done. Rin will now open an initialization TUI.",
      "You can exit it anytime; the installer will print the next-step reminder afterwards.",
    ].join("\n"),
    outroInstalled: (targetUser, installedServiceKind, options) => {
      const serviceSuffix = installedServiceKind
        ? ` (${installedServiceKind} service installed).`
        : "";
      const openCommand = options?.openCommand || "rin";
      const pathHint =
        options?.launcherDir && options.launcherDirOnPath === false
          ? [
              `Open Rin after reopening your shell: ${openCommand}`,
              options.immediateCommand
                ? `Use now: ${options.immediateCommand}`
                : "",
              `Note: the current shell PATH does not include ${options.launcherDir}; reopening the shell lets existing PATH startup rules see the new launcher directory.`,
            ].filter(Boolean)
          : [`Open Rin: ${openCommand}`];
      return [
        `Installer wrote config for ${targetUser}.${serviceSuffix}`,
        ...pathHint,
      ].join("\n");
    },
    installStepFailed: "Install step failed.",
    installStepComplete: "Install step complete.",
    startingLogin: (providerName: string) =>
      `Starting ${providerName} login...`,
    openUrlToContinueLogin: (url: string, instructions?: string) =>
      `Open this URL to continue login:\n${url}${instructions ? `\n${instructions}` : ""}`,
    deviceCodeLoginInstructions: (userCode: string) =>
      `Enter device code: ${userCode}`,
    enterLoginValueMessage: "Enter login value.",
    waitingForLogin: (providerName: string) =>
      `Waiting for ${providerName} login...`,
    manualCodeInputMessage: "Paste the redirect URL or code from the browser.",
    manualCodePlaceholder: (lastAuthUrl: string) =>
      lastAuthUrl
        ? "paste the final redirect URL or device code"
        : "paste the code",
    loginComplete: (providerName: string) => `${providerName} login complete.`,
    loginFailed: (providerName: string) => `Login failed for ${providerName}.`,
    enterApiKeyMessage: (providerName: string) =>
      `Enter the API key or token for ${providerName}.`,
    tokenRequired: "A token is required.",
  },
  zh_CN: {
    languagePrompt: {
      chooseMessage: "选择安装器语言",
      detectedSuffix: "已检测",
      customLabel: "其他",
      customHint: "输入任意区域语言代码",
      textMessage: "输入区域语言代码",
      invalidLanguageTag: "请输入有效的区域语言代码，例如 zh_CN",
    },
    chatCommandDescriptions: {
      help: "显示可用命令",
      abort: "中止当前操作",
      new: "开始新会话",
      compact: "压缩当前会话",
      reload: "重新加载扩展、提示词、技能和主题",
      usage: "显示用量和配额状态",
    },
    chatRuntime: {
      working: {
        frames: ["工作中...", "工作中", "工作中.", "工作中.."],
      },
      telegramWorking: {
        workingInitial: "工作中...",
        workingSuffix: "工作中",
        thinkingInitial: "工作中...",
        thinkingSuffix: "工作中",
        separator: "-----------",
        prompts: [
          "工作中 (๑•̀ㅂ•́)و✧",
          "正在整理内容 (｡･ω･｡)",
          "正在处理细节 (つω`｡)",
          "信息梳理中 (ﾉ◕ヮ◕)ﾉ*:･ﾟ✧",
          "马上就好，继续工作中 (ง •̀_•́)ง",
          "工作中，请稍等 (｀・ω・´)",
        ],
      },
    },
    installerCancelled: "安装器已取消。",
    introTitle: "Rin 安装器",
    safetyBoundaryTitle: "安全边界",
    targetUserTitle: "目标用户",
    installChoicesTitle: "安装选项",
    ownershipCheckTitle: "所有权检查",
    writtenPathsTitle: "已写入路径",
    targetInstallDirLabel: "Rin 目录",
    writtenPathLabel: "已写入",
    serviceLabelLabel: "标签",
    launchingInitTitle: "启动初始化",
    afterInitTitle: "初始化后",
    confirmActiveLabel: "是",
    confirmInactiveLabel: "否",
    existingDirectoryTitle: "已有目录",
    installDirectoryTitle: "本地 Rin 配置",
    currentUserLabel: "当前用户",
    existingOtherUserLabel: "现有其他用户",
    newUserLabel: "新用户",
    chooseInstallTargetMessage: "Rin 要安装到哪里？",
    currentInstallTargetLabel: "当前用户",
    localUserInstallTargetLabel: "本机其他用户",
    sshInstallTargetLabel: "已有 SSH 主机",
    containerInstallTargetLabel: "本机容器隔离环境",
    cloudInstallTargetLabel: "新云主机",
    vmInstallTargetLabel: "新虚拟机",
    nasInstallTargetLabel: "NAS 隔离环境",
    sameMachineHint: "同一台机器",
    reuseSshAuthHint: "复用现有 ssh 配置和认证",
    containerIsolationHint: "Docker 或 Podman 隔离",
    providerApiProvisionerHint: "通过 provider API 创建环境",
    hypervisorProvisionerHint: "通过虚拟化后端创建环境",
    nasIsolationHint: "厂商应用/容器隔离环境",
    sshTargetMessage: "SSH 目标（Host 别名或 user@host）",
    sshTargetRequired: "必须填写 SSH 目标",
    targetNameMessage: "未来 rin --target 使用的目标名称",
    targetNameRequired: "必须填写目标名称",
    containerEngineMessage: "容器引擎",
    containerImageMessage: "基础镜像",
    chooseDeploymentProviderMessage: (kind: string) => `选择 ${kind} provider`,
    noneFoundHint: "未找到",
    usersHint: (count: number) => `共 ${count} 个用户`,
    newUserHint: "输入用户名",
    existingDirectoryText(
      installDir: string,
      entryCount: number,
      sample: string[],
    ) {
      return [
        `路径已存在: ${installDir}`,
        `现有条目数: ${entryCount}`,
        sample.length ? `示例: ${sample.join(", ")}` : "",
        "",
        "安装器策略：",
        "- 保留未知文件不动",
        "- 保留现有配置，除非必须更新所需文件",
        "- 仅在确认属于旧版 Rin 遗留物时才删除旧文件",
      ]
        .filter(Boolean)
        .join("\n");
    },
    newDirectoryText: (installDir: string) =>
      [
        `将创建本地 Rin 配置: ${installDir}`,
        "",
        "安装器策略：",
        "- 仅创建 Rin 必需的文件",
        "- 未来更新应保留未知文件",
      ].join("\n"),
    chooseTargetUserMessage: "选择 Rin 守护进程的目标用户。",
    chooseExistingUserMessage: "选择承载 Rin 守护进程的现有用户。",
    enterNewUsernameMessage: "输入要为 Rin 守护进程创建的新用户名。",
    usernamePlaceholder: "rin",
    usernameRequired: "用户名不能为空。",
    usernameInvalid: "请输入正常的 Unix 用户名。",
    chooseDefaultTargetMessage: (targetUser: string) =>
      `是否将 ${targetUser} 设为当前安装器用户后续运行 rin / rin update 时的默认目标用户？`,
    defaultTargetLabel: "默认目标用户",
    defaultTargetSetValue: (targetUser: string) => `设为 ${targetUser}`,
    defaultTargetSkippedValue: "不设置",
    chooseProviderMessage: "选择要认证并使用的模型提供商。",
    chooseModelMessage: "选择模型。",
    chooseThinkingLevelMessage: "选择默认思考强度。",
    providerReadyHint: "已就绪",
    providerNeedsAuthHint: "需要认证/配置",
    subscriptionAuthLabel: "订阅",
    apiAuthLabel: "API",
    modelCountLabel: (count: number) => `${count} 个模型`,
    reasoningHint: "推理",
    noReasoningHint: "无推理",
    noModelsAvailableError: "rin_installer_no_models_available",
    noModelsForProviderError: (provider: string) =>
      `rin_installer_no_models_for_provider:${provider}`,
    fieldRequired: "此项必填。",
    valueRequired: "此项不能为空。",
    validUrlRequired: "请输入有效 URL。",
    installSafetyBoundaryLines: [
      "Rin 安全边界：",
      "- Rin 始终运行在 YOLO 模式。",
      "- shell / 文件操作没有沙箱。",
      "- Rin 将以所选系统账号的完整用户级权限运行。",
      "- 它可能读取文件、修改文件、执行命令，并访问该账号可用的网络资源。",
      "- 提示词、工具输出、文件内容、记忆上下文与搜索结果可能会发送给当前模型/提供商，因此敏感数据可能暴露。",
      "",
      "除可见聊天轮次外，可能产生额外 Token 开销：",
      "- 正常轮次中注入的记忆提示块",
      "- 首次运行的初始化回合",
      "- 会话关闭或 `/new` 交接时的记忆提取",
      "- 会话关闭或 `/new` 交接时的 episode 综合",
      "- 会话上下文过大时的压缩 / 总结",
      "- assistant 或脚本委派工作时触发的非交互 `rin -p` / `rin --mode json` 回合",
      "- scheduled task / 聊天接入触发的 agent 运行",
      "- 使用 browse 时加入模型上下文的搜索结果文本",
    ],
    buildInstallSafetyBoundaryText() {
      return this.installSafetyBoundaryLines.join("\n");
    },
    buildInstallPlanText(options) {
      const skippedForNow = "暂不设置";
      const authStatus = options.provider
        ? options.authAvailable
          ? "已就绪"
          : "稍后需要认证/配置"
        : skippedForNow;
      return [
        `目标守护进程用户: ${options.targetUser}`,
        `Rin 目录: ${options.installDir}`,
        `语言: ${options.language}`,
        `提供商: ${options.provider || skippedForNow}`,
        `模型: ${options.modelId || skippedForNow}`,
        `思考强度: ${options.thinkingLevel || skippedForNow}`,
        `模型认证状态: ${authStatus}`,
        `${this.defaultTargetLabel}: ${options.setDefaultTarget ? this.defaultTargetSetValue(options.targetUser) : this.defaultTargetSkippedValue}`,
      ]
        .filter(Boolean)
        .join("\n");
    },
    updaterIntroTitle: "Rin 更新器",
    updateTargetsTitle: "更新目标",
    updatePlanTitle: "更新计划",
    updatingTargetTitle: "正在应用更新",
    updatedTargetTitle: "已更新目标",
    chooseUpdateTargetMessage: "选择要更新的已安装 Rin 目标。",
    noUpdateTargetsText: "当前系统上未发现已安装的 Rin 守护进程目标。",
    updaterNothingUpdated: "未执行更新。",
    updaterFinishedWithoutWritingChanges: "更新器结束，未写入变更。",
    updateAlreadyCurrentTitle: "已是最新",
    fetchAndApplyUpdateConfirmMessage: "现在获取并应用此更新吗？",
    publishUpdateConfirmMessage: "现在将已准备好的运行时发布到此目标吗？",
    publishingUpdateMessage: "正在发布运行时并刷新已安装目标……",
    fetchingUpdateSourceMessage: "正在获取更新源",
    preparingUpdateSourceMessage: "正在准备更新源",
    installingUpdateDependenciesMessage: "正在安装更新依赖",
    buildingUpdateRuntimeMessage: "正在构建更新运行时",
    pruningUpdateDependenciesMessage: "正在裁剪更新依赖",
    buildUpdateCommandFailureHeader: (label: string) =>
      `${label}失败；最近日志：`,
    formatUpdateDiscoverySource(source) {
      const labels: Record<string, string> = {
        launcher: "启动器",
        default: "默认安装目标",
        manifest: "安装清单",
        systemd: "systemd 用户服务",
        launchd: "launchd 代理",
      };
      return labels[String(source || "").trim()] || source;
    },
    formatUpdateSourceLabel(sourceLabel) {
      const text = String(sourceLabel || "").trim();
      if (/^stable latest$/i.test(text)) return "稳定版最新";
      return (
        text
          .replace(/^stable version\s+/i, "稳定版版本 ")
          .replace(/^stable\s+/i, "稳定版 ")
          .replace(/^beta version\s+/i, "beta 版本 ")
          .replace(/^beta branch\s+/i, "beta 分支 ")
          .replace(/^beta\s+/i, "beta ")
          .replace(/^nightly\s+/i, "nightly ")
          .replace(/^git ref\s+/i, "Git 引用 ")
          .replace(/^git branch\s+/i, "Git 分支 ") || text
      );
    },
    formatUpdateServiceHint(serviceHint) {
      const text = String(serviceHint || "").trim();
      const labels: Record<string, string> = {
        "A macOS launchd LaunchAgent will be installed and started for this daemon.":
          "将为此守护进程安装并启动 macOS launchd LaunchAgent。",
        "You skipped launchd installation for now; start the daemon explicitly when needed.":
          "你暂时跳过了 launchd 安装；需要时请显式启动守护进程。",
        "A Linux user service will be installed and started for this daemon when supported.":
          "如平台支持，将为此守护进程安装并启动 Linux 用户服务。",
        "You skipped dedicated Linux service installation for now; start the daemon explicitly when needed.":
          "你暂时跳过了专用 Linux 服务安装；需要时请显式启动守护进程。",
        "A Windows Startup launcher will be installed for this daemon.":
          "将为此守护进程安装 Windows 启动项。",
        "No dedicated service was installed; the installer will not start the daemon for you.":
          "未安装专用服务；安装器不会替你启动守护进程。",
      };
      return labels[text] || text;
    },
    buildUpdateTargetText(options) {
      return [
        `当前用户: ${options.currentUser}`,
        `选中的守护进程用户: ${options.targetUser}`,
        `${this.targetInstallDirLabel}: ${options.installDir}`,
        `发现来源: ${this.formatUpdateDiscoverySource(options.source)}`,
        `用户主目录: ${options.ownerHome}`,
      ].join("\n");
    },
    buildUpdatePlanText(options) {
      return [
        `当前用户: ${options.currentUser}`,
        `选中的守护进程用户: ${options.targetUser}`,
        `Rin 目录: ${options.installDir}`,
        `发现来源: ${this.formatUpdateDiscoverySource(options.source)}`,
        `用户主目录: ${options.ownerHome}`,
        `请求来源: ${this.formatUpdateSourceLabel(options.sourceLabel)}`,
        "",
        "更新器策略：",
        "- 将新的运行时版本发布到现有 Rin 目录",
        "- 清理旧运行时版本，仅保留最近 3 个",
        "- 为当前用户刷新启动器和安装器元数据",
        "- 如适用，刷新托管守护进程服务文件并重启守护进程",
        "- 保留现有提供商、认证和设置，除非其他流程显式修改",
      ].join("\n");
    },
    buildUpdateAlreadyCurrentText(options) {
      return [
        `${this.targetInstallDirLabel}: ${options.installDir}`,
        `当前来源: ${this.formatUpdateSourceLabel(options.sourceLabel)}`,
        "无需下载或修改运行时。",
      ].join("\n");
    },
    buildUpdatedTargetText(options) {
      return [
        `${this.targetInstallDirLabel}: ${options.installDir}`,
        ...options.writtenPaths.map(
          (item) => `${this.writtenPathLabel}: ${item}`,
        ),
        `已移除旧运行时版本: ${options.prunedReleaseCount}`,
        options.serviceKind && options.serviceLabel
          ? `${options.serviceKind} ${this.serviceLabelLabel}: ${options.serviceLabel}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    },
    buildAfterUpdateText(options) {
      return [
        `服务/平台提示: ${this.formatUpdateServiceHint(options.serviceHint)}`,
        `守护进程已立即启动: ${options.daemonReady ? "是" : "否"}`,
        "",
        "建议的下一步命令：",
        `- 诊断: rin doctor${options.userSuffix}`,
        `- 打开 Rin: rin${options.userSuffix}`,
        "- 如果 RPC 模式失败，请运行 `rin doctor` 或重新打开 Rin 进入临时维护模式",
      ].join("\n");
    },
    updaterOutroUpdated(targetUser, installDir, daemonReady, userSuffix) {
      return `更新器已刷新 ${targetUser} 位于 ${installDir} 的安装。${daemonReady ? `请用 rin${userSuffix} 打开。` : `如需手动启动守护进程，请使用 rin start${userSuffix}。`}`;
    },
    buildPostInstallInitExitText(options) {
      const rinCommand = options.rinCommand || "rin";
      const userSuffix =
        options.currentUser === options.targetUser
          ? ""
          : ` -u ${options.targetUser}`;
      return [
        "初始化 TUI 已退出。",
        "",
        "下次可用：",
        `- 打开 Rin: ${rinCommand}${userSuffix}`,
        `- 如有需要，检查守护进程状态: ${rinCommand} doctor${userSuffix}`,
        "- 仅在 agent 重置初始化完成状态后才会重新进入初始化",
      ].join("\n");
    },
    buildFinalRequirements(options) {
      return [
        "写入配置与启动器",
        "将运行时发布到 Rin 目录",
        options.installServiceNow
          ? "安装并启动守护进程服务"
          : "在此平台上跳过守护进程服务安装",
        options.needsElevatedWrite || options.needsElevatedService
          ? "如目标用户或 Rin 目录需要，请使用 sudo/doas"
          : "当前预计不需要额外提权",
      ];
    },
    finalizeInstallationMessage: (finalRequirements: string[]) =>
      [
        "现在完成安装吗？",
        ...finalRequirements.map((item) => `- ${item}`),
      ].join("\n"),
    noEligibleUsersText: (currentUser: string, visibleUsers: string[]) =>
      [
        "在当前系统上未找到可选的现有用户。",
        `检测到的当前用户: ${currentUser}`,
        `可见用户: ${visibleUsers.join(", ") || "无"}`,
      ].join("\n"),
    nothingInstalled: "未执行安装。",
    installerFinishedWithoutWritingChanges: "安装器结束，未写入变更。",
    ownershipMismatchText(ownership) {
      return [
        `目标目录 owner uid/gid: ${ownership.statUid}:${ownership.statGid}`,
        `目标用户 uid/gid: ${ownership.targetUid}:${ownership.targetGid}`,
        "该目录当前并不归所选目标用户所有。",
        "如果安装器有权限，它仍会继续写入配置，但在完全切换前你可能需要先修复所有权。",
      ].join("\n");
    },
    ownershipNotWritableText: "当前安装器进程对默认本地 Rin 目录没有写权限。",
    preparingInstallerMessage: "正在准备安装器上下文……",
    applyingTargetSelectionMessage: "正在应用目标选择……",
    inspectingInstallDirectoryMessage: "正在检查本地 Rin 配置……",
    loadingModelChoicesMessage: "正在加载模型和提供商状态……",
    savingProviderAuthMessage: "正在保存提供商认证……",
    refreshingInstalledTargetMessage: "正在发布运行时并刷新已安装目标……",
    publishingRuntimeMessageElevated: "正在以提权方式发布运行时并写入配置……",
    publishingRuntimeMessage: "正在发布运行时并写入配置……",
    launchingInitText: [
      "安装已完成。Rin 现在将打开初始化 TUI。",
      "你可以随时退出；安装器随后会打印下一步提示。",
    ].join("\n"),
    outroInstalled: (targetUser, installedServiceKind, options) => {
      const serviceSuffix = installedServiceKind
        ? `（已安装 ${installedServiceKind} 服务。）`
        : "";
      const openCommand = options?.openCommand || "rin";
      const pathHint =
        options?.launcherDir && options.launcherDirOnPath === false
          ? [
              `重开 shell 后打开 Rin: ${openCommand}`,
              options.immediateCommand
                ? `现在可先用: ${options.immediateCommand}`
                : "",
              `提示：当前 shell 的 PATH 尚未包含 ${options.launcherDir}；重开 shell 后，已有的 PATH 启动规则会看到新建的 launcher 目录。`,
            ].filter(Boolean)
          : [`打开 Rin: ${openCommand}`];
      return [
        `已为 ${targetUser} 写入安装配置。${serviceSuffix}`,
        ...pathHint,
      ].join("\n");
    },
    installStepFailed: "安装步骤失败。",
    installStepComplete: "安装步骤完成。",
    startingLogin: (providerName: string) => `正在启动 ${providerName} 登录……`,
    openUrlToContinueLogin: (url: string, instructions?: string) =>
      `打开以下链接以继续登录：\n${url}${instructions ? `\n${instructions}` : ""}`,
    deviceCodeLoginInstructions: (userCode: string) =>
      `输入设备验证码：${userCode}`,
    enterLoginValueMessage: "输入登录所需的值。",
    waitingForLogin: (providerName: string) =>
      `正在等待 ${providerName} 登录……`,
    manualCodeInputMessage: "粘贴浏览器中的回调 URL 或验证码。",
    manualCodePlaceholder: (lastAuthUrl: string) =>
      lastAuthUrl ? "粘贴最终回调 URL 或设备验证码" : "粘贴验证码",
    loginComplete: (providerName: string) => `${providerName} 登录完成。`,
    loginFailed: (providerName: string) => `${providerName} 登录失败。`,
    enterApiKeyMessage: (providerName: string) =>
      `输入 ${providerName} 的 API key 或 token。`,
    tokenRequired: "Token 不能为空。",
  },
} satisfies Record<InstallerDisplayLanguage, InstallerDisplayCopy>;

function detectedInstallerLanguageInitialValue(detected: string) {
  const exactOption = LANGUAGE_OPTIONS.find(
    (option) => option.value !== "custom" && option.value === detected,
  );
  return exactOption?.value || resolveInstallerDisplayLanguage(detected);
}

export async function promptInstallerLanguage(
  prompt: InstallerLanguagePromptApi,
) {
  const detected = detectLocalLanguageTag();
  const promptDisplayLanguage = resolveInstallerDisplayLanguage(detected);
  const copy = INSTALLER_DISPLAY_COPY[promptDisplayLanguage].languagePrompt;
  const selected = String(
    prompt.ensureNotCancelled(
      await prompt.select({
        message: copy.chooseMessage,
        initialValue: detectedInstallerLanguageInitialValue(detected),
        options: LANGUAGE_OPTIONS.map((option) => ({
          ...option,
          label: option.value === "custom" ? copy.customLabel : option.label,
          hint:
            option.value === "custom"
              ? copy.customHint
              : option.value === detected
                ? `${option.hint} · ${copy.detectedSuffix}`
                : option.hint,
        })),
      }),
    ),
  ).trim();
  if (selected !== "custom") return normalizeLanguageTag(selected);
  return normalizeLanguageTag(
    prompt.ensureNotCancelled(
      await prompt.text({
        message: copy.textMessage,
        placeholder: detected || DEFAULT_LANGUAGE_TAG,
        defaultValue: detected || DEFAULT_LANGUAGE_TAG,
        validate(value: string) {
          return normalizeLanguageTag(value, "")
            ? undefined
            : copy.invalidLanguageTag;
        },
      }),
    ),
    DEFAULT_LANGUAGE_TAG,
  );
}

export function createRinI18n(languageTag = DEFAULT_LANGUAGE_TAG) {
  const language = normalizeLanguageTag(languageTag);
  const displayLanguage = resolveInstallerDisplayLanguage(language);
  const copy = INSTALLER_DISPLAY_COPY[displayLanguage];

  return {
    language,
    displayLanguage,
    isChinese: displayLanguage === "zh_CN",
    ...copy,
  };
}

export function createInstallerI18n(languageTag = DEFAULT_LANGUAGE_TAG) {
  return createRinI18n(languageTag);
}
