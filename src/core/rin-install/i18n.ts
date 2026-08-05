export type InstallerI18n = ReturnType<typeof createInstallerI18n>;

type ChatCommandDescriptions = Record<
  "help" | "abort" | "new" | "compact" | "reload" | "usage" | "status",
  string
>;

type ChatRuntimeCopy = {
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
  updateReinstallCurrentTitle: string;
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
  buildUpdateReinstallCurrentText: (options: {
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

const INSTALLER_DISPLAY_COPY: InstallerDisplayCopy = {
  chatCommandDescriptions: {
    help: "Show available commands",
    abort: "Abort current operation",
    new: "Start a new session",
    compact: "Compact the current session",
    reload: "Reload extensions, prompts, skills, and themes",
    usage: "Show usage and quota status",
    status: "Show this chat session status",
  },
  chatRuntime: {
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
  chooseDeploymentProviderMessage: (kind: string) => `Choose ${kind} provider`,
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
  chooseExistingUserMessage: "Choose the existing user to host the Rin daemon.",
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
  updateReinstallCurrentTitle: "Reinstalling current version",
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
      "- preserve existing provider/auth/settings except fields removed by the current runtime",
    ].join("\n");
  },
  buildUpdateReinstallCurrentText(options) {
    return [
      `${this.targetInstallDirLabel}: ${options.installDir}`,
      `Current source: ${this.formatUpdateSourceLabel(options.sourceLabel)}`,
      "The current version will be reinstalled to restore managed runtime files.",
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
  startingLogin: (providerName: string) => `Starting ${providerName} login...`,
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
};

export function createRinI18n() {
  return {
    ...INSTALLER_DISPLAY_COPY,
    chatCommandDescriptions: {
      ...INSTALLER_DISPLAY_COPY.chatCommandDescriptions,
    },
    chatRuntime: {
      telegramWorking: {
        ...INSTALLER_DISPLAY_COPY.chatRuntime.telegramWorking,
        prompts: [
          ...INSTALLER_DISPLAY_COPY.chatRuntime.telegramWorking.prompts,
        ],
      },
    },
    installSafetyBoundaryLines: [
      ...INSTALLER_DISPLAY_COPY.installSafetyBoundaryLines,
    ],
  };
}

export function createInstallerI18n() {
  return createRinI18n();
}
