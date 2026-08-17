import path from "node:path";

import { select, spinner, text } from "@clack/prompts";
import type { Api, Model } from "@earendil-works/pi-ai";

import { loadRinAgentRuntime } from "../rin-lib/agent-runtime.js";
import { createInstallerI18n, type InstallerI18n } from "../i18n.js";
import { installAuthPath } from "./paths.js";
import { runInstallerProgress } from "./progress.js";

export type InstallerModelChoice = Model<Api> & {
  providerLabel: string;
  authKind: "subscription" | "api";
  available: boolean;
};

async function createInstallerProviderState(
  installDir: string,
  readJsonFile: <T>(filePath: string, fallback: T) => T,
) {
  const agentRuntimeModule = await loadRinAgentRuntime();
  const { AuthStorage, ModelRuntime, createModelRegistry } =
    agentRuntimeModule as any;
  const authPath = installDir ? installAuthPath(installDir) : "";
  const existingAuth = authPath ? readJsonFile<any>(authPath, {}) : {};
  const authStorage = AuthStorage.inMemory(existingAuth);
  const modelsJsonPath = installDir
    ? path.join(installDir, "models.json")
    : undefined;
  const modelRuntime = await ModelRuntime.create({
    credentials: authStorage,
    modelsPath: modelsJsonPath,
  });
  const modelRegistry = createModelRegistry(modelRuntime, authStorage);
  return { authStorage, modelRegistry };
}

export async function loadModelChoices(
  installDir = "",
  readJsonFile: <T>(filePath: string, fallback: T) => T = (
    _filePath,
    fallback,
  ) => fallback,
) {
  const { authStorage, modelRegistry } = await createInstallerProviderState(
    installDir,
    readJsonFile,
  );
  const oauthProviders = Array.isArray(authStorage.getOAuthProviders?.())
    ? authStorage.getOAuthProviders()
    : [];
  const subscriptionProviders = new Set(
    oauthProviders
      .map((entry: any) => String(entry?.id || "").trim())
      .filter(Boolean),
  );
  const providerLabel = (provider: string) =>
    String(
      modelRegistry.getProviderDisplayName?.(provider) || provider,
    ).trim() || provider;
  const providerAuthKind = (provider: string): "subscription" | "api" =>
    subscriptionProviders.has(provider) ? "subscription" : "api";
  const merged = new Map<string, InstallerModelChoice>();

  const models = Array.isArray(modelRegistry.getAll?.())
    ? modelRegistry.getAll()
    : [];
  for (const model of models) {
    const provider = String((model as any).provider || "").trim();
    const id = String((model as any).id || "").trim();
    if (!provider || !id) continue;
    merged.set(`${provider}/${id}`, {
      ...(model as Model<Api>),
      provider,
      providerLabel: providerLabel(provider),
      authKind: providerAuthKind(provider),
      id,
      reasoning: Boolean((model as any).reasoning),
      available: Boolean(modelRegistry.hasConfiguredAuth?.(model)),
    });
  }

  const choices = [...merged.values()];
  choices.sort(
    (a, b) =>
      (a.authKind === b.authKind
        ? 0
        : a.authKind === "subscription"
          ? -1
          : 1) ||
      a.providerLabel.localeCompare(b.providerLabel) ||
      a.provider.localeCompare(b.provider) ||
      a.id.localeCompare(b.id),
  );
  return choices;
}

export async function createInstallerAuthStorage(
  installDir: string,
  readJsonFile: <T>(filePath: string, fallback: T) => T,
) {
  const { authStorage } = await createInstallerProviderState(
    installDir,
    readJsonFile,
  );
  return authStorage;
}

export async function configureProviderAuth(
  provider: string,
  installDir: string,
  deps: {
    readJsonFile: <T>(filePath: string, fallback: T) => T;
    ensureNotCancelled: <T>(value: T | symbol) => T;
    i18n?: InstallerI18n;
    createAuthStorage?: (
      installDir: string,
      readJsonFile: <T>(filePath: string, fallback: T) => T,
    ) => any | Promise<any>;
    selectPrompt?: (options: any) => Promise<any>;
    textPrompt?: (options: any) => Promise<any>;
    spinnerFactory?: typeof spinner;
  },
) {
  const i18n = deps.i18n || createInstallerI18n();
  const authStorage = await runInstallerProgress(
    i18n.loadingModelChoicesMessage,
    () =>
      (deps.createAuthStorage || createInstallerAuthStorage)(
        installDir,
        deps.readJsonFile,
      ),
    {
      successMessage: i18n.installStepComplete,
      failureMessage: i18n.installStepFailed,
    },
  );
  if (authStorage.hasAuth?.(provider)) {
    return {
      available: true,
      authKind: "existing",
      authData: authStorage.getAll?.() || {},
    };
  }

  const oauthProviders = Array.isArray(authStorage.getOAuthProviders?.())
    ? authStorage.getOAuthProviders()
    : [];
  const oauthProvider = oauthProviders.find(
    (entry: any) => entry.id === provider,
  );

  if (oauthProvider) {
    const loginSpinner = (deps.spinnerFactory || spinner)();
    let lastAuthUrl = "";
    loginSpinner.start(i18n.startingLogin(oauthProvider.name || provider));
    try {
      await authStorage.login(provider, {
        onAuth(info: { url: string; instructions?: string }) {
          lastAuthUrl = String(info?.url || "");
          loginSpinner.stop(
            i18n.openUrlToContinueLogin(lastAuthUrl, info?.instructions),
          );
        },
        onDeviceCode(info: { userCode: string; verificationUri: string }) {
          lastAuthUrl = String(info?.verificationUri || "");
          const userCode = String(info?.userCode || "").trim();
          loginSpinner.stop(
            i18n.openUrlToContinueLogin(
              lastAuthUrl,
              userCode ? i18n.deviceCodeLoginInstructions(userCode) : undefined,
            ),
          );
          loginSpinner.start(
            i18n.waitingForLogin(oauthProvider.name || provider),
          );
        },
        async onPrompt(prompt: {
          message: string;
          placeholder?: string;
          allowEmpty?: boolean;
        }) {
          const allowEmpty = Boolean(prompt.allowEmpty);
          const value = String(
            deps.ensureNotCancelled(
              await (deps.textPrompt || text)({
                message: prompt.message || i18n.enterLoginValueMessage,
                placeholder: prompt.placeholder,
                validate(value) {
                  if (!allowEmpty && !String(value || "").trim())
                    return i18n.valueRequired;
                },
              }),
            ),
          ).trim();
          loginSpinner.start(
            i18n.waitingForLogin(oauthProvider.name || provider),
          );
          return value;
        },
        onProgress(message: string) {
          loginSpinner.message(
            message || i18n.waitingForLogin(oauthProvider.name || provider),
          );
        },
        async onSelect(prompt: {
          message: string;
          options: { id: string; label: string }[];
        }) {
          const options = Array.isArray(prompt.options)
            ? prompt.options
                .map((option) => ({
                  value: String(option?.id || "").trim(),
                  label: String(option?.label || option?.id || "").trim(),
                }))
                .filter((option) => option.value)
            : [];
          if (!options.length) return undefined;
          loginSpinner.stop(prompt.message || i18n.enterLoginValueMessage);
          const value = String(
            deps.ensureNotCancelled(
              await (deps.selectPrompt || select)({
                message: prompt.message || i18n.enterLoginValueMessage,
                options,
              }),
            ),
          ).trim();
          loginSpinner.start(
            i18n.waitingForLogin(oauthProvider.name || provider),
          );
          return value || undefined;
        },
        async onManualCodeInput() {
          const value = String(
            deps.ensureNotCancelled(
              await (deps.textPrompt || text)({
                message: i18n.manualCodeInputMessage,
                placeholder: i18n.manualCodePlaceholder(lastAuthUrl),
                validate(value) {
                  if (!String(value || "").trim()) return i18n.valueRequired;
                },
              }),
            ),
          ).trim();
          loginSpinner.start(
            i18n.waitingForLogin(oauthProvider.name || provider),
          );
          return value;
        },
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });
      loginSpinner.stop(i18n.loginComplete(oauthProvider.name || provider));
      return {
        available: true,
        authKind: "oauth",
        authData: authStorage.getAll?.() || {},
      };
    } catch (error: any) {
      loginSpinner.stop(i18n.loginFailed(oauthProvider.name || provider));
      throw error;
    }
  }

  const token = String(
    deps.ensureNotCancelled(
      await (deps.textPrompt || text)({
        message: i18n.enterApiKeyMessage(provider),
        placeholder: "token",
        validate(value) {
          if (!String(value || "").trim()) return i18n.tokenRequired;
        },
      }),
    ),
  ).trim();
  return await runInstallerProgress(
    i18n.savingProviderAuthMessage,
    () => {
      authStorage.set(provider, { type: "api_key", key: token });
      return {
        available: true,
        authKind: "api_key",
        authData: authStorage.getAll?.() || {},
      };
    },
    {
      successMessage: i18n.installStepComplete,
      failureMessage: i18n.installStepFailed,
    },
  );
}
