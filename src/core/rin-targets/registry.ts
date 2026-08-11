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
    };

export type RinTargetRecord = {
  name: string;
  kind: RinTargetKind;
  label?: string;
  createdAt: string;
  updatedAt: string;
  default?: boolean;
  runtime: RinRuntimeTransport;
  metadata?: Record<string, unknown>;
};

export type DeploymentProviderKind = "container";

export type DeploymentProviderDescriptor = {
  kind: DeploymentProviderKind;
  id: string;
  label: string;
  recommendedIsolation: string;
  requiredInputs: string[];
  defaultRuntime: "container";
  notes: string[];
};

export const TARGET_KIND_LABELS: Record<RinTargetKind, string> = {
  "local-user": "Local user",
  ssh: "Existing SSH host",
  container: "Local container",
};

export const DEPLOYMENT_PROVIDERS: DeploymentProviderDescriptor[] = [
  {
    kind: "container",
    id: "docker",
    label: "Docker",
    recommendedIsolation: "named container + persistent volumes",
    requiredInputs: ["container name"],
    defaultRuntime: "container",
    notes: [
      "Uses docker exec after installation.",
      "Does not install host launchers or host user services.",
    ],
  },
  {
    kind: "container",
    id: "podman",
    label: "Podman",
    recommendedIsolation: "named container + persistent volumes",
    requiredInputs: ["container name"],
    defaultRuntime: "container",
    notes: [
      "Uses podman exec after installation.",
      "Rootless Podman is preferred when available.",
    ],
  },
];

export function normalizeTargetName(value: string) {
  const next = safeString(value).trim().toLowerCase();
  if (!next) return "";
  return next.replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function isValidTargetName(value: string) {
  return /^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(safeString(value).trim());
}

export function findDeploymentProviders(kind: DeploymentProviderKind) {
  return DEPLOYMENT_PROVIDERS.filter((provider) => provider.kind === kind);
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
