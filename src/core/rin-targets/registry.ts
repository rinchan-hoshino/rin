import { safeString } from "../text-utils.js";

export type RinTargetKind = "local-user" | "ssh" | "container";

export type RinRuntimeTransport =
  | { kind: "local-user"; user: string }
  | {
      kind: "ssh";
      host: string;
      user?: string;
      port?: number;
      controlPath?: string;
      identityFile?: string;
    }
  | {
      kind: "container";
      engine: "docker" | "podman";
      container: string;
      user?: string;
      installDir?: string;
    };

export type RinTargetRecord = {
  name: string;
  kind: RinTargetKind;
  label?: string;
  createdAt: string;
  updatedAt: string;
  runtime: RinRuntimeTransport;
  metadata?: Record<string, unknown>;
};

export const TARGET_KIND_LABELS: Record<RinTargetKind, string> = {
  "local-user": "Local user",
  ssh: "Existing SSH host",
  container: "Local container",
};

export function normalizeTargetName(value: string) {
  const next = safeString(value).trim().toLowerCase();
  if (!next) return "";
  return next.replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function isValidTargetName(value: string) {
  return /^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(safeString(value).trim());
}

export function isValidContainerImageReference(value: unknown) {
  return /^[A-Za-z0-9][A-Za-z0-9._/@:-]*$/.test(safeString(value).trim());
}

export function isSupportedTargetRecord(
  value: unknown,
): value is RinTargetRecord {
  if (!value || typeof value !== "object") return false;
  const target = value as any;
  if (!target.runtime || typeof target.runtime !== "object") return false;
  if (target.kind === "local-user") return target.runtime.kind === "local-user";
  if (target.kind === "ssh") return target.runtime.kind === "ssh";
  if (target.kind === "container") return target.runtime.kind === "container";
  return false;
}
