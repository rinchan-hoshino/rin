import path from "node:path";

import { spinner, text } from "@clack/prompts";

import { computeAvailableThinkingLevels } from "../model-thinking-levels.js";
import { loadRinCodingAgent } from "../rin-lib/loader.js";
import { createInstallerI18n, type InstallerI18n } from "./i18n.js";
import { installAuthPath } from "./paths.js";
import { runInstallerProgress } from "./progress.js";

export { computeAvailableThinkingLevels };

export async function loadModelChoices(
  installDir = "",
  readJsonFile: <T>(filePath: string, fallback: T) => T = (
    _filePath,
    fallback,
  ) => fallback,
) {
  const codingAgentModule = await loadRinCodingAgent();
  const { AuthStorage, ModelRegistry } = codingAgentModule as any;
  const authPath = installDir ? installAuthPath(installDir) : "";
  const existingAuth = authPath ? readJsonFile<any>(authPath, {}) : {};
  const authStorage = AuthStorage.inMemory(existingAuth);
  const modelsJsonPath = installDir
    ? path.join(installDir, "models.json")
    : undefined;
  const modelRegistry = new ModelRegistry(authStorage, modelsJsonPath);
  const merged = new Map<
    string,
    { provider: string; id: string; reasoning: boolean; available: boolean }
  >();

  const models = Array.isArray(modelRegistry.getAll?.())
    ? modelRegistry.getAll()
    : [];
  for (const model of models) {
    const provider = String((model as any).provider || "").trim();
    const id = String((model as any).id || "").trim();
    if (!provider || !id) continue;
    merged.set(`${provider}/${id}`, {
      provider,
      id,
      reasoning: Boolean((model as any).reasoning),
      available: Boolean(modelRegistry.hasConfiguredAuth?.(model)),
    });
  }

  const choices = [...merged.values()];
  choices.sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
  );
  return choices;
}

export async function createInstallerAuthStorage(
  installDir: string,
  readJsonFile: <T>(filePath: string, fallback: T) => T,
) {
  const codingAgentModule = await loadRinCodingAgent();
  const { AuthStorage } = codingAgentModule as any;
  const authPath = installAuthPath(installDir);
  const existing = readJsonFile<any>(authPath, {});
  return AuthStorage.inMemory(existing);
}

export async function configureProviderAuth(
  provider: string,
  installDir: string,
  deps: {
    readJsonFile: <T>(filePath: string, fallback: T) => T;
    ensureNotCancelled: <T>(value: T | symbol) => T;
    i18n?: InstallerI18n;
  },
) {
  const i18n = deps.i18n || createInstallerI18n();
  const authStorage = await runInstallerProgress(
    i18n.loadingModelChoicesMessage,
    () => createInstallerAuthStorage(installDir, deps.readJsonFile),
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
    const loginSpinner = spinner();
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
        async onPrompt(prompt: { message: string; placeholder?: string }) {
          const value = String(
            deps.ensureNotCancelled(
              await text({
                message: prompt.message || i18n.enterLoginValueMessage,
                placeholder: prompt.placeholder,
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
        onProgress(message: string) {
          loginSpinner.message(
            message || i18n.waitingForLogin(oauthProvider.name || provider),
          );
        },
        async onManualCodeInput() {
          const value = String(
            deps.ensureNotCancelled(
              await text({
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
      await text({
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
