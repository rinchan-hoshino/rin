import { asArray, isJsonRecord } from "../json-utils.js";

export type RpcResourceItem = unknown;

export type RpcResourceDiagnostic = {
  type?: string;
  message?: string;
  path?: string;
  collision?: {
    name?: string;
    winnerPath?: string;
    loserPath?: string;
  };
};

export type RpcResourceSnapshot = {
  skills: {
    skills: RpcResourceItem[];
    diagnostics: RpcResourceDiagnostic[];
  };
  prompts: {
    prompts: RpcResourceItem[];
    diagnostics: RpcResourceDiagnostic[];
  };
  themes: {
    themes: RpcResourceItem[];
    diagnostics: RpcResourceDiagnostic[];
  };
  extensions: {
    extensions: RpcResourceItem[];
    errors: RpcResourceItem[];
    diagnostics: RpcResourceDiagnostic[];
    commandDiagnostics: RpcResourceDiagnostic[];
    shortcutDiagnostics: RpcResourceDiagnostic[];
  };
};

export function emptyRpcResourceSnapshot(): RpcResourceSnapshot {
  return {
    skills: { skills: [], diagnostics: [] },
    prompts: { prompts: [], diagnostics: [] },
    themes: { themes: [], diagnostics: [] },
    extensions: {
      extensions: [],
      errors: [],
      diagnostics: [],
      commandDiagnostics: [],
      shortcutDiagnostics: [],
    },
  };
}

function record(value: unknown) {
  return isJsonRecord(value) ? value : {};
}

function normalizeResourceSection(value: unknown, itemKey: string) {
  const section = record(value);
  return {
    items: asArray<RpcResourceItem>(section[itemKey]),
    diagnostics: asArray<RpcResourceDiagnostic>(section.diagnostics),
  };
}

export function normalizeRpcResourceSnapshot(
  value: unknown,
): RpcResourceSnapshot {
  const snapshot = record(value);
  const skills = normalizeResourceSection(snapshot.skills, "skills");
  const prompts = normalizeResourceSection(snapshot.prompts, "prompts");
  const themes = normalizeResourceSection(snapshot.themes, "themes");
  const extensions = record(snapshot.extensions);
  return {
    skills: { skills: skills.items, diagnostics: skills.diagnostics },
    prompts: { prompts: prompts.items, diagnostics: prompts.diagnostics },
    themes: { themes: themes.items, diagnostics: themes.diagnostics },
    extensions: {
      extensions: asArray<RpcResourceItem>(extensions.extensions),
      errors: asArray<RpcResourceItem>(extensions.errors),
      diagnostics: asArray<RpcResourceDiagnostic>(extensions.diagnostics),
      commandDiagnostics: asArray<RpcResourceDiagnostic>(
        extensions.commandDiagnostics,
      ),
      shortcutDiagnostics: asArray<RpcResourceDiagnostic>(
        extensions.shortcutDiagnostics,
      ),
    },
  };
}
