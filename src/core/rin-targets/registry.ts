import { safeString } from "../text-utils.js";

export type RinTargetKind =
  | "local-user"
  | "ssh"
  | "container"
  | "cloud"
  | "nas"
  | "vm";

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
    }
  | {
      kind: "command";
      command: string;
      argsBeforeRin: string[];
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

export type DeploymentProviderKind = "cloud" | "nas" | "vm" | "container";

export type DeploymentProviderDescriptor = {
  kind: DeploymentProviderKind;
  id: string;
  label: string;
  recommendedIsolation: string;
  requiredInputs: string[];
  defaultRuntime: "ssh" | "container" | "local";
  notes: string[];
};

export const TARGET_KIND_LABELS: Record<RinTargetKind, string> = {
  "local-user": "Local user",
  ssh: "Existing SSH host",
  container: "Local container",
  cloud: "Cloud instance",
  nas: "NAS isolated runtime",
  vm: "Virtual machine",
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
      "Does not install host GUI launchers or host user services.",
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
  ...[
    ["hetzner", "Hetzner Cloud"],
    ["digitalocean", "DigitalOcean Droplets"],
  ].map(([id, label]) => ({
    kind: "cloud" as const,
    id,
    label,
    recommendedIsolation: "dedicated Linux VM created through the provider API",
    requiredInputs: ["API token", "region"],
    defaultRuntime: "ssh" as const,
    notes: [
      "Provision with the provider CLI and cloud-init, then run the normal Rin installer inside the instance.",
      "Only providers with an implemented create/install/register loop are listed here.",
    ],
  })),
  ...[
    ["synology", "Synology DSM"],
    ["qnap", "QNAP QTS/QuTS"],
    ["truenas-scale", "TrueNAS SCALE"],
    ["unraid", "Unraid"],
  ].map(([id, label]) => ({
    kind: "nas" as const,
    id,
    label,
    recommendedIsolation: "vendor container/app runtime when available",
    requiredInputs: ["NAS address", "NAS API/session credentials"],
    defaultRuntime: "container" as const,
    notes: [
      "Prefer the vendor-recommended isolated app/container runtime over modifying the NAS host OS.",
      "Fall back to SSH only when the NAS explicitly supports a normal Linux shell with Node.js/npm.",
    ],
  })),
  ...[["multipass", "Multipass"]].map(([id, label]) => ({
    kind: "vm" as const,
    id,
    label,
    recommendedIsolation: "fresh Linux VM from a cloud image plus cloud-init",
    requiredInputs: ["VM name", "CPU/memory/disk defaults or overrides"],
    defaultRuntime: "ssh" as const,
    notes: [
      "Create the VM from scratch, install prerequisites through cloud-init, then run the Rin installer.",
      "Register Multipass exec as the target runtime.",
    ],
  })),
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

export function findDeploymentProvider(
  kind: DeploymentProviderKind,
  id: string,
) {
  const nextId = safeString(id).trim().toLowerCase();
  return DEPLOYMENT_PROVIDERS.find(
    (provider) => provider.kind === kind && provider.id === nextId,
  );
}
