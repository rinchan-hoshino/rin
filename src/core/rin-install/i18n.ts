import {
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
  { value: "en", label: "English", hint: "en" },
  { value: "zh-CN", label: "简体中文", hint: "zh-CN" },
  { value: "zh-TW", label: "繁體中文", hint: "zh-TW" },
  { value: "ja", label: "日本語", hint: "ja" },
  { value: "ko", label: "한국어", hint: "ko" },
  { value: "fr", label: "Français", hint: "fr" },
  { value: "es", label: "Español", hint: "es" },
  { value: "de", label: "Deutsch", hint: "de" },
  { value: "pt-BR", label: "Português (Brasil)", hint: "pt-BR" },
  { value: "ru", label: "Русский", hint: "ru" },
  { value: "ar", label: "العربية", hint: "ar" },
  { value: "hi", label: "हिन्दी", hint: "hi" },
  { value: "custom", label: "Other", hint: "Enter any BCP 47 language tag" },
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
  | "help"
  | "abort"
  | "new"
  | "compact"
  | "reload"
  | "status"
  | "session"
  | "model",
  string
>;

type InstallerDisplayCopy = {
  languagePrompt: InstallerLanguagePromptCopy;
  chatCommandDescriptions: ChatCommandDescriptions;
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
  chooseInstallDirMessage: string;
  chooseDefaultTargetMessage: (targetUser: string) => string;
  defaultTargetLabel: string;
  defaultTargetSetValue: (targetUser: string) => string;
  defaultTargetSkippedValue: string;
  directoryRequired: string;
  directoryMustBeAbsolute: string;
  chooseProviderMessage: string;
  chooseModelMessage: string;
  chooseThinkingLevelMessage: string;
  providerReadyHint: string;
  providerNeedsAuthHint: string;
  reasoningHint: string;
  noReasoningHint: string;
  noModelsAvailableError: string;
  noModelsForProviderError: (provider: string) => string;
  whereToFindLabel: string;
  openLabel: string;
  fieldRequired: string;
  valueRequired: string;
  validUrlRequired: string;
  configureChatBridgeNowMessage: string;
  chooseChatPlatformMessage: string;
  guidedSetupHint: string;
  telegramHint: string;
  onebotHint: string;
  slackHint: string;
  buildGuide: (
    this: InstallerDisplayCopy,
    message: string,
    guide?: string,
    links?: string | string[],
  ) => string;
  chatDisabledDescription: string;
  telegramTokenMessage: string;
  telegramTokenGuide: string;
  telegramTokenDetail: string;
  onebotEndpointMessage: string;
  onebotEndpointGuide: string;
  onebotSelfIdMessage: string;
  onebotSelfIdGuide: string;
  onebotTokenMessage: string;
  onebotTokenGuide: string;
  optionalTokenPlaceholder: string;
  onebotDetail: (protocol: string, endpoint: string) => string;
  discordTokenMessage: string;
  discordTokenGuide: string;
  discordDetail: string;
  qqAppIdMessage: string;
  qqCredentialsGuide: string;
  qqSecretMessage: string;
  qqTokenMessage: string;
  qqScopeMessage: string;
  qqScopeGuide: string;
  publicLabel: string;
  privateLabel: string;
  qqDetail: string;
  larkPlatformMessage: string;
  larkPlatformGuide: string;
  feishuLabel: string;
  larkLabel: string;
  feishuHint: string;
  larkHint: string;
  larkAppIdMessage: string;
  larkAppIdGuide: string;
  larkAppSecretMessage: string;
  larkDetail: (platform: string) => string;
  slackAppTokenMessage: string;
  slackAppTokenGuide: string;
  slackBotTokenMessage: string;
  slackBotTokenGuide: string;
  slackDetail: string;
  minecraftUrlMessage: string;
  minecraftUrlGuide: string;
  minecraftSelfIdMessage: string;
  minecraftServerNameMessage: string;
  minecraftTokenMessage: string;
  minecraftDetail: (url: string) => string;
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
      chatDescription: string;
      chatDetail: string;
      language: string;
      setDefaultTarget: boolean;
    },
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
  publishingRuntimeMessageElevated: string;
  publishingRuntimeMessage: string;
  launchingInitText: string;
  outroInstalled: (targetUser: string, installedServiceKind?: string) => string;
  installStepFailed: string;
  installStepComplete: string;
  startingLogin: (providerName: string) => string;
  openUrlToContinueLogin: (url: string, instructions?: string) => string;
  enterLoginValueMessage: string;
  waitingForLogin: (providerName: string) => string;
  manualCodeInputMessage: string;
  manualCodePlaceholder: (lastAuthUrl: string) => string;
  loginComplete: (providerName: string) => string;
  loginFailed: (providerName: string) => string;
  enterApiKeyMessage: (providerName: string) => string;
  tokenRequired: string;
};

function formatOpenLinks(links?: string | string[]) {
  const list = (Array.isArray(links) ? links : [links])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  return list.join(" · ");
}

const INSTALLER_DISPLAY_COPY = {
  en: {
    languagePrompt: {
      chooseMessage: "Choose installer language",
      detectedSuffix: "detected",
      customLabel: "Other",
      customHint: "Enter any BCP 47 language tag",
      textMessage: "Enter language tag (BCP 47)",
      invalidLanguageTag: "Use a valid BCP 47 language tag",
    },
    chatCommandDescriptions: {
      help: "Show available commands",
      abort: "Abort current operation",
      new: "Start a new session",
      compact: "Compact the current session",
      reload: "Reload extensions, prompts, skills, and themes",
      status: "Show current chat processing status",
      session: "Show current session status",
      model: "Show or change the current model",
    },
    installerCancelled: "Installer cancelled.",
    introTitle: "Rin Installer",
    safetyBoundaryTitle: "Safety boundary",
    targetUserTitle: "Target user",
    installChoicesTitle: "Install choices",
    ownershipCheckTitle: "Ownership check",
    writtenPathsTitle: "Written paths",
    targetInstallDirLabel: "Target install dir",
    writtenPathLabel: "Written",
    serviceLabelLabel: "label",
    launchingInitTitle: "Launching init",
    afterInitTitle: "After init",
    confirmActiveLabel: "Yes",
    confirmInactiveLabel: "No",
    existingDirectoryTitle: "Existing directory",
    installDirectoryTitle: "Install directory",
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
        `Directory exists: ${installDir}`,
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
        `Directory will be created: ${installDir}`,
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
    chooseInstallDirMessage:
      "Choose the Rin data directory for the daemon user.",
    chooseDefaultTargetMessage: (targetUser: string) =>
      `Set ${targetUser} as the default target user for future rin / rin update runs from this launcher user?`,
    defaultTargetLabel: "Default target user",
    defaultTargetSetValue: (targetUser: string) => `set to ${targetUser}`,
    defaultTargetSkippedValue: "not set",
    directoryRequired: "Directory is required.",
    directoryMustBeAbsolute: "Use an absolute path.",
    chooseProviderMessage: "Choose a provider to authenticate and use.",
    chooseModelMessage: "Choose a model.",
    chooseThinkingLevelMessage: "Choose the default thinking level.",
    providerReadyHint: "ready",
    providerNeedsAuthHint: "needs auth/config",
    reasoningHint: "reasoning",
    noReasoningHint: "no reasoning",
    noModelsAvailableError: "rin_installer_no_models_available",
    noModelsForProviderError: (provider: string) =>
      `rin_installer_no_models_for_provider:${provider}`,
    whereToFindLabel: "Where to find it",
    openLabel: "Open",
    fieldRequired: "This field is required.",
    valueRequired: "A value is required.",
    validUrlRequired: "Use a valid URL.",
    configureChatBridgeNowMessage: "Configure a chat bridge now?",
    chooseChatPlatformMessage: "Choose a chat platform.",
    guidedSetupHint: "guided setup",
    telegramHint: "bot token",
    onebotHint: "endpoint + protocol",
    slackHint: "app token + bot token",
    buildGuide(message: string, guide?: string, links?: string | string[]) {
      const lines = [message.trim()];
      if (guide) lines.push(`${this.whereToFindLabel}: ${guide.trim()}`);
      const openLinks = formatOpenLinks(links);
      if (openLinks) lines.push(`${this.openLabel}: ${openLinks}`);
      return lines.join("\n");
    },
    chatDisabledDescription: "disabled for now",
    telegramTokenMessage: "Enter the Telegram bot token.",
    telegramTokenGuide: "Telegram @BotFather → choose your bot → API token.",
    telegramTokenDetail:
      "Chat bridge mode: polling · token saved to target settings.json",
    onebotEndpointMessage: "Enter the OneBot endpoint URL.",
    onebotEndpointGuide:
      "Your OneBot bridge or client config, for example NapCat, LLOneBot, or another OneBot server.",
    onebotSelfIdMessage:
      "Enter the OneBot self ID if you already know it. Leave blank to fill later.",
    onebotSelfIdGuide:
      "Usually the bot QQ number from your OneBot client or bridge config.",
    onebotTokenMessage:
      "Enter the OneBot access token if required. Leave blank otherwise.",
    onebotTokenGuide:
      "Use the access token from your OneBot server config only if you enabled one.",
    optionalTokenPlaceholder: "optional token",
    onebotDetail: (protocol: string, endpoint: string) =>
      `Chat bridge mode: ${protocol} · endpoint: ${endpoint}`,
    discordTokenMessage: "Enter the Discord bot token.",
    discordTokenGuide:
      "Discord Developer Portal → your application → Bot → Reset Token / Token.",
    discordDetail: "Chat bridge token: [saved to target settings.json]",
    qqAppIdMessage: "Enter the QQ bot app ID.",
    qqCredentialsGuide:
      "QQ bot developer docs → create your bot application → app credentials.",
    qqSecretMessage: "Enter the QQ bot secret.",
    qqTokenMessage: "Enter the QQ bot token.",
    qqScopeMessage: "Choose the QQ bot scope.",
    qqScopeGuide: "Use the bot type shown in your QQ bot application settings.",
    publicLabel: "Public",
    privateLabel: "Private",
    qqDetail:
      "Chat bridge mode: websocket · app credentials saved to target settings.json",
    larkPlatformMessage: "Choose the Lark / Feishu region.",
    larkPlatformGuide:
      "If your app is on open.feishu.cn use Feishu. If it is on open.larksuite.com use Lark.",
    feishuLabel: "Feishu",
    larkLabel: "Lark",
    feishuHint: "China / open.feishu.cn",
    larkHint: "Global / open.larksuite.com",
    larkAppIdMessage: "Enter the Lark / Feishu app ID.",
    larkAppIdGuide:
      "Developer console → your app → Credentials / Basic information.",
    larkAppSecretMessage: "Enter the Lark / Feishu app secret.",
    larkDetail: (platform: string) =>
      `Chat bridge mode: ws · platform: ${platform} · app credentials saved to target settings.json`,
    slackAppTokenMessage: "Enter the Slack app-level token.",
    slackAppTokenGuide:
      "Slack app settings → Basic Information or Socket Mode → App-Level Tokens (starts with xapp-).",
    slackBotTokenMessage: "Enter the Slack bot token.",
    slackBotTokenGuide:
      "Slack app settings → OAuth & Permissions → Bot User OAuth Token (starts with xoxb-).",
    slackDetail: "Chat bridge mode: ws",
    minecraftUrlMessage: "Enter the Minecraft QueQiao WebSocket URL.",
    minecraftUrlGuide:
      "Use the WebSocket address exposed by your QueQiao bridge or Minecraft adapter.",
    minecraftSelfIdMessage:
      "Enter the Minecraft bridge self ID if you want a custom one. Leave blank to use minecraft.",
    minecraftServerNameMessage:
      "Enter the Minecraft server name if you want it shown in chat logs. Leave blank otherwise.",
    minecraftTokenMessage:
      "Enter the QueQiao access token if required. Leave blank otherwise.",
    minecraftDetail: (url: string) => `Chat bridge mode: ws · endpoint: ${url}`,
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
      "- the first-run /init onboarding conversation",
      "- memory extraction during session shutdown or `/new` handoff",
      "- episode synthesis during session shutdown or `/new` handoff",
      "- context compaction / summarization when the session grows large",
      "- non-interactive `rin -p` / `rin --mode json` turns when the assistant or a script delegates work",
      "- scheduled task / chat-bridge-triggered agent runs that create their own turns",
      "- web-search result text added into the model context when search is used",
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
        `Install dir: ${options.installDir}`,
        `Language: ${options.language}`,
        `Provider: ${options.provider || skippedForNow}`,
        `Model: ${options.modelId || skippedForNow}`,
        `Thinking level: ${options.thinkingLevel || skippedForNow}`,
        `Model auth status: ${authStatus}`,
        `${this.defaultTargetLabel}: ${options.setDefaultTarget ? this.defaultTargetSetValue(options.targetUser) : this.defaultTargetSkippedValue}`,
        `Chat bridge: ${options.chatDescription}`,
        options.chatDetail,
        options.chatDescription === this.chatDisabledDescription
          ? ""
          : "Chat authorization: installer guidance covers the first OWNER setup once; later role changes should be requested in normal conversation, not slash commands.",
      ]
        .filter(Boolean)
        .join("\n");
    },
    buildPostInstallInitExitText(options) {
      const rinCommand = options.rinCommand || "rin";
      const userSuffix =
        options.currentUser === options.targetUser
          ? ""
          : ` -u ${options.targetUser}`;
      const pathHint =
        options.launcherDir && options.launcherDirOnPath === false
          ? [
              "",
              "PATH note:",
              `- the current shell PATH does not include ${options.launcherDir}; add it to PATH to use plain rin.`,
              `- temporary fix: export PATH="${options.launcherDir}:$PATH"`,
            ]
          : [];
      return [
        "Initialization TUI exited.",
        "",
        "Next time:",
        `- open Rin: ${rinCommand}${userSuffix}`,
        `- check daemon state if needed: ${rinCommand} doctor${userSuffix}`,
        "- restart onboarding from inside Rin with `/init`",
        ...pathHint,
      ].join("\n");
    },
    buildFinalRequirements(options) {
      return [
        "write configuration and launchers",
        "publish the runtime into the install directory",
        options.installServiceNow
          ? "install and start the daemon service"
          : "skip daemon service installation on this platform",
        options.needsElevatedWrite || options.needsElevatedService
          ? "use sudo/doas if needed for the selected target and install dir"
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
      "The selected install directory is not writable by the current installer process.",
    publishingRuntimeMessageElevated:
      "Publishing runtime and writing configuration with elevated permissions...",
    publishingRuntimeMessage: "Publishing runtime and writing configuration...",
    launchingInitText: [
      "Installation is done. Rin will now open an initialization TUI.",
      "You can exit it anytime; the installer will print the next-step reminder afterwards.",
    ].join("\n"),
    outroInstalled: (targetUser: string, installedServiceKind?: string) =>
      `Installer wrote config for ${targetUser}.${installedServiceKind ? ` (${installedServiceKind} service installed).` : ""}`,
    installStepFailed: "Install step failed.",
    installStepComplete: "Install step complete.",
    startingLogin: (providerName: string) =>
      `Starting ${providerName} login...`,
    openUrlToContinueLogin: (url: string, instructions?: string) =>
      `Open this URL to continue login:\n${url}${instructions ? `\n${instructions}` : ""}`,
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
  "zh-CN": {
    languagePrompt: {
      chooseMessage: "选择安装器语言",
      detectedSuffix: "已检测",
      customLabel: "其他",
      customHint: "输入任意 BCP 47 语言标签",
      textMessage: "输入语言标签（BCP 47）",
      invalidLanguageTag: "请输入有效的 BCP 47 语言标签",
    },
    chatCommandDescriptions: {
      help: "显示可用命令",
      abort: "中止当前操作",
      new: "开始新会话",
      compact: "压缩当前会话",
      reload: "重新加载扩展、提示词、技能和主题",
      status: "显示当前聊天处理状态",
      session: "显示当前会话状态",
      model: "显示或切换当前模型",
    },
    installerCancelled: "安装器已取消。",
    introTitle: "Rin 安装器",
    safetyBoundaryTitle: "安全边界",
    targetUserTitle: "目标用户",
    installChoicesTitle: "安装选项",
    ownershipCheckTitle: "所有权检查",
    writtenPathsTitle: "已写入路径",
    targetInstallDirLabel: "目标安装目录",
    writtenPathLabel: "已写入",
    serviceLabelLabel: "标签",
    launchingInitTitle: "启动初始化",
    afterInitTitle: "初始化后",
    confirmActiveLabel: "是",
    confirmInactiveLabel: "否",
    existingDirectoryTitle: "已有目录",
    installDirectoryTitle: "安装目录",
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
        `目录已存在: ${installDir}`,
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
        `将创建目录: ${installDir}`,
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
    chooseInstallDirMessage: "选择该守护进程用户的 Rin 数据目录。",
    chooseDefaultTargetMessage: (targetUser: string) =>
      `是否将 ${targetUser} 设为当前安装器用户后续运行 rin / rin update 时的默认目标用户？`,
    defaultTargetLabel: "默认目标用户",
    defaultTargetSetValue: (targetUser: string) => `设为 ${targetUser}`,
    defaultTargetSkippedValue: "不设置",
    directoryRequired: "目录不能为空。",
    directoryMustBeAbsolute: "请输入绝对路径。",
    chooseProviderMessage: "选择要认证并使用的模型提供商。",
    chooseModelMessage: "选择模型。",
    chooseThinkingLevelMessage: "选择默认思考强度。",
    providerReadyHint: "已就绪",
    providerNeedsAuthHint: "需要认证/配置",
    reasoningHint: "推理",
    noReasoningHint: "无推理",
    noModelsAvailableError: "rin_installer_no_models_available",
    noModelsForProviderError: (provider: string) =>
      `rin_installer_no_models_for_provider:${provider}`,
    whereToFindLabel: "获取位置",
    openLabel: "打开",
    fieldRequired: "此项必填。",
    valueRequired: "此项不能为空。",
    validUrlRequired: "请输入有效 URL。",
    configureChatBridgeNowMessage: "现在配置聊天接入吗？",
    chooseChatPlatformMessage: "选择聊天平台。",
    guidedSetupHint: "引导配置",
    telegramHint: "机器人令牌",
    onebotHint: "端点 + 协议",
    slackHint: "app token + bot token",
    buildGuide(message: string, guide?: string, links?: string | string[]) {
      const lines = [message.trim()];
      if (guide) lines.push(`${this.whereToFindLabel}: ${guide.trim()}`);
      const openLinks = formatOpenLinks(links);
      if (openLinks) lines.push(`${this.openLabel}: ${openLinks}`);
      return lines.join("\n");
    },
    chatDisabledDescription: "暂不启用",
    telegramTokenMessage: "输入 Telegram 机器人令牌。",
    telegramTokenGuide: "Telegram @BotFather → 选择你的机器人 → API token。",
    telegramTokenDetail:
      "聊天接入模式：polling · 令牌已保存到目标 settings.json",
    onebotEndpointMessage: "输入 OneBot 端点 URL。",
    onebotEndpointGuide:
      "你的 OneBot 接入服务或客户端配置，例如 NapCat、LLOneBot 或其他 OneBot 服务。",
    onebotSelfIdMessage:
      "如果你已经知道 OneBot self ID，请输入；否则留空稍后再填。",
    onebotSelfIdGuide: "通常是 OneBot 客户端或接入配置中的机器人 QQ 号。",
    onebotTokenMessage: "如果需要，请输入 OneBot access token；否则留空。",
    onebotTokenGuide: "仅在你的 OneBot 服务端配置启用了 access token 时填写。",
    optionalTokenPlaceholder: "可选令牌",
    onebotDetail: (protocol: string, endpoint: string) =>
      `聊天接入模式：${protocol} · 端点：${endpoint}`,
    discordTokenMessage: "输入 Discord 机器人令牌。",
    discordTokenGuide:
      "Discord Developer Portal → 你的应用 → Bot → Reset Token / Token。",
    discordDetail: "聊天接入令牌：[已保存到目标 settings.json]",
    qqAppIdMessage: "输入 QQ 机器人 App ID。",
    qqCredentialsGuide: "QQ 机器人开发者文档 → 创建机器人应用 → app 凭据。",
    qqSecretMessage: "输入 QQ 机器人密钥。",
    qqTokenMessage: "输入 QQ 机器人令牌。",
    qqScopeMessage: "选择 QQ 机器人范围。",
    qqScopeGuide: "使用 QQ 机器人应用设置中显示的机器人类型。",
    publicLabel: "公开",
    privateLabel: "私有",
    qqDetail: "聊天接入模式：websocket · 应用凭据已保存到目标 settings.json",
    larkPlatformMessage: "选择 Lark / 飞书区域。",
    larkPlatformGuide:
      "如果你的应用在 open.feishu.cn 上，选飞书；如果在 open.larksuite.com 上，选 Lark。",
    feishuLabel: "Feishu",
    larkLabel: "Lark",
    feishuHint: "中国 / open.feishu.cn",
    larkHint: "全球 / open.larksuite.com",
    larkAppIdMessage: "输入 Lark / 飞书 app ID。",
    larkAppIdGuide: "开发者后台 → 你的应用 → 凭据 / 基本信息。",
    larkAppSecretMessage: "输入 Lark / 飞书 app secret。",
    larkDetail: (platform: string) =>
      `聊天接入模式：ws · 平台：${platform} · 应用凭据已保存到目标 settings.json`,
    slackAppTokenMessage: "输入 Slack app-level token。",
    slackAppTokenGuide:
      "Slack 应用设置 → Basic Information 或 Socket Mode → App-Level Tokens（以 xapp- 开头）。",
    slackBotTokenMessage: "输入 Slack bot token。",
    slackBotTokenGuide:
      "Slack 应用设置 → OAuth & Permissions → Bot User OAuth Token（以 xoxb- 开头）。",
    slackDetail: "聊天接入模式：ws",
    minecraftUrlMessage: "输入 Minecraft QueQiao WebSocket URL。",
    minecraftUrlGuide:
      "使用 QueQiao 接入服务或 Minecraft 适配器暴露出的 WebSocket 地址。",
    minecraftSelfIdMessage:
      "如果你想自定义 Minecraft 接入 self ID，请输入；否则留空使用 minecraft。",
    minecraftServerNameMessage:
      "如果你希望聊天日志显示 Minecraft 服务器名称，请输入；否则留空。",
    minecraftTokenMessage: "如果需要，请输入 QueQiao access token；否则留空。",
    minecraftDetail: (url: string) => `聊天接入模式：ws · 端点：${url}`,
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
      "- 首次运行的 /init 引导对话",
      "- 会话关闭或 `/new` 交接时的记忆提取",
      "- 会话关闭或 `/new` 交接时的 episode 综合",
      "- 会话上下文过大时的压缩 / 总结",
      "- assistant 或脚本委派工作时触发的非交互 `rin -p` / `rin --mode json` 回合",
      "- scheduled task / 聊天接入触发的 agent 运行",
      "- 使用 web search 时加入模型上下文的搜索结果文本",
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
        `安装目录: ${options.installDir}`,
        `语言: ${options.language}`,
        `提供商: ${options.provider || skippedForNow}`,
        `模型: ${options.modelId || skippedForNow}`,
        `思考强度: ${options.thinkingLevel || skippedForNow}`,
        `模型认证状态: ${authStatus}`,
        `${this.defaultTargetLabel}: ${options.setDefaultTarget ? this.defaultTargetSetValue(options.targetUser) : this.defaultTargetSkippedValue}`,
        `聊天接入: ${options.chatDescription}`,
        options.chatDetail,
        options.chatDescription === this.chatDisabledDescription
          ? ""
          : "聊天授权：安装流程会一次性引导首次 OWNER 设置；后续角色变更应通过自然语言对话提出，不使用 slash command。",
      ]
        .filter(Boolean)
        .join("\n");
    },
    buildPostInstallInitExitText(options) {
      const rinCommand = options.rinCommand || "rin";
      const userSuffix =
        options.currentUser === options.targetUser
          ? ""
          : ` -u ${options.targetUser}`;
      const pathHint =
        options.launcherDir && options.launcherDirOnPath === false
          ? [
              "",
              "PATH 提示：",
              `- 当前 shell 的 PATH 尚未包含 ${options.launcherDir}；如需直接输入 rin，请将它加入 PATH。`,
              `- 临时修复: export PATH="${options.launcherDir}:$PATH"`,
            ]
          : [];
      return [
        "初始化 TUI 已退出。",
        "",
        "下次可用：",
        `- 打开 Rin: ${rinCommand}${userSuffix}`,
        `- 如有需要，检查守护进程状态: ${rinCommand} doctor${userSuffix}`,
        "- 在 Rin 内通过 `/init` 重新开始引导",
        ...pathHint,
      ].join("\n");
    },
    buildFinalRequirements(options) {
      return [
        "写入配置与启动器",
        "将运行时发布到安装目录",
        options.installServiceNow
          ? "安装并启动守护进程服务"
          : "在此平台上跳过守护进程服务安装",
        options.needsElevatedWrite || options.needsElevatedService
          ? "如目标用户或安装目录需要，请使用 sudo/doas"
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
    ownershipNotWritableText: "当前安装器进程对所选安装目录没有写权限。",
    publishingRuntimeMessageElevated: "正在以提权方式发布运行时并写入配置……",
    publishingRuntimeMessage: "正在发布运行时并写入配置……",
    launchingInitText: [
      "安装已完成。Rin 现在将打开初始化 TUI。",
      "你可以随时退出；安装器随后会打印下一步提示。",
    ].join("\n"),
    outroInstalled: (targetUser: string, installedServiceKind?: string) =>
      `已为 ${targetUser} 写入安装配置。${installedServiceKind ? `（已安装 ${installedServiceKind} 服务。）` : ""}`,
    installStepFailed: "安装步骤失败。",
    installStepComplete: "安装步骤完成。",
    startingLogin: (providerName: string) => `正在启动 ${providerName} 登录……`,
    openUrlToContinueLogin: (url: string, instructions?: string) =>
      `打开以下链接以继续登录：\n${url}${instructions ? `\n${instructions}` : ""}`,
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

export async function promptInstallerLanguage(
  prompt: InstallerLanguagePromptApi,
) {
  const detected = detectLocalLanguageTag("en");
  const promptDisplayLanguage = resolveInstallerDisplayLanguage(detected);
  const copy = INSTALLER_DISPLAY_COPY[promptDisplayLanguage].languagePrompt;
  const selected = String(
    prompt.ensureNotCancelled(
      await prompt.select({
        message: copy.chooseMessage,
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
  if (selected !== "custom") return normalizeLanguageTag(selected, "en");
  return normalizeLanguageTag(
    prompt.ensureNotCancelled(
      await prompt.text({
        message: copy.textMessage,
        placeholder: detected || "en",
        defaultValue: detected || "en",
        validate(value: string) {
          return normalizeLanguageTag(value, "")
            ? undefined
            : copy.invalidLanguageTag;
        },
      }),
    ),
    "en",
  );
}

export function createRinI18n(languageTag = "en") {
  const language = normalizeLanguageTag(languageTag, "en");
  const displayLanguage = resolveInstallerDisplayLanguage(language);
  const copy = INSTALLER_DISPLAY_COPY[displayLanguage];

  return {
    language,
    displayLanguage,
    isChinese: displayLanguage === "zh-CN",
    ...copy,
  };
}

export function createInstallerI18n(languageTag = "en") {
  return createRinI18n(languageTag);
}
