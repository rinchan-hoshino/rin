import type { RinCapabilityDefinition } from "../rin-lib/capability-types.js";
import path from "node:path";

import {
  promptChatBridgeSetup,
  type ChatBridgePromptApi,
} from "../chat-bridge/setup.js";
import { resolveRuntimeProfile } from "../rin-lib/profile.js";
import { normalizeStoredChatSettings } from "./settings.js";
import { readJsonFile, writeJsonFile } from "./support.js";

const CHAT_BRIDGE_COMMAND_CANCELLED = "chat_bridge_setup_cancelled";

function formatSelectLabel(
  item: { label?: string; hint?: string },
  index: number,
) {
  const label = String(item.label || "").trim() || `Option ${index + 1}`;
  const hint = String(item.hint || "").trim();
  return hint ? `${label} — ${hint}` : label;
}

function createUiPromptApi(ui: any): ChatBridgePromptApi {
  return {
    ensureNotCancelled<T>(value: T | symbol | undefined | null) {
      if (value === undefined || value === null) {
        throw new Error(CHAT_BRIDGE_COMMAND_CANCELLED);
      }
      return value as T;
    },
    async select(options: any) {
      const items = Array.isArray(options?.options)
        ? options.options.map((item: any, index: number) => {
            if (item && typeof item === "object") {
              return {
                value: item.value,
                label: formatSelectLabel(item, index),
              };
            }
            const text = String(item ?? `Option ${index + 1}`);
            return { value: item, label: text };
          })
        : [];
      const labels = items.map((item) => item.label);
      const choice = await ui.select(
        String(options?.message || "Choose:"),
        labels,
      );
      if (choice === undefined) return undefined;
      const index = labels.indexOf(String(choice));
      return index >= 0 ? items[index].value : undefined;
    },
    async text(options: any) {
      const title = String(options?.message || "Input");
      const placeholderParts = [
        String(options?.placeholder || "").trim(),
        String(options?.defaultValue || "").trim()
          ? `default: ${String(options.defaultValue).trim()}`
          : "",
      ].filter(Boolean);
      const placeholder = placeholderParts.join(" · ") || undefined;
      for (;;) {
        const raw = await ui.input(title, placeholder);
        if (raw === undefined) return undefined;
        const text =
          String(raw || "").trim() ||
          String(options?.defaultValue || "").trim();
        const error =
          typeof options?.validate === "function"
            ? options.validate(text)
            : undefined;
        if (error) {
          ui.notify(String(error), "warning");
          continue;
        }
        return text;
      }
    },
    async confirm(options: any) {
      return await ui.confirm(
        "Chat bridge",
        String(options?.message || "Confirm?"),
      );
    },
  };
}

export async function runChatBridgeConfigureCommand(ui: any) {
  if (
    !ui ||
    typeof ui.select !== "function" ||
    typeof ui.input !== "function" ||
    typeof ui.confirm !== "function"
  ) {
    ui?.notify?.("/chat requires interactive mode", "error");
    return false;
  }

  const prompt = createUiPromptApi(ui);
  const profile = resolveRuntimeProfile();
  const settingsPath = path.join(profile.agentDir, "settings.json");
  const settings = normalizeStoredChatSettings(
    readJsonFile<any>(settingsPath, {}),
    {
      ensureChat: true,
    },
  );

  let result;
  try {
    result = await promptChatBridgeSetup(prompt, {
      confirmEnable: false,
    });
  } catch (error: any) {
    if (String(error?.message || error) === CHAT_BRIDGE_COMMAND_CANCELLED) {
      ui.notify("Chat bridge setup cancelled.", "info");
      return true;
    }
    throw error;
  }

  const adapterKey = String(result?.adapterKey || "").trim();
  if (!adapterKey || !result?.chatConfig) {
    ui.notify("Chat bridge setup skipped.", "info");
    return true;
  }

  if (settings.chat[adapterKey] !== undefined) {
    const overwrite = await ui.confirm(
      "Chat bridge",
      `Replace the existing ${result.chatDescription} configuration?`,
    );
    if (!overwrite) {
      ui.notify("Chat bridge setup cancelled.", "info");
      return true;
    }
  }

  settings.chat[adapterKey] = result.chatConfig[adapterKey];
  writeJsonFile(settingsPath, settings);

  const lines = [
    `Chat bridge updated: ${result.chatDescription}`,
    result.chatDetail,
    "Restart Rin to apply the updated chat configuration.",
  ].filter(Boolean);
  ui.notify(lines.join("\n"), "info");
  return true;
}

export default function configureChatBridgeCommandModule(): RinCapabilityDefinition {
  return { name: "chat-configure" };
}
