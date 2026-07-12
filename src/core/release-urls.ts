const DEFAULT_PACKAGE_NAME = "@hoshinorin/rin";
const DEFAULT_STABLE_VERSION = "0.0.0";

function trim(value: unknown) {
  return String(value || "").trim();
}

function resolveGitHubCodeloadRepoPath(repoUrl: string) {
  const normalizedRepo = trim(repoUrl)
    .replace(/\.git$/i, "")
    .replace(/\/+$/g, "");
  const sshMatch = /^git@github\.com:([^/]+)\/([^/]+)$/i.exec(normalizedRepo);
  if (sshMatch?.[1] && sshMatch[2]) {
    return [sshMatch[1], sshMatch[2]].map(encodeURIComponent).join("/");
  }
  try {
    const parsed = new URL(normalizedRepo);
    if (parsed.hostname.toLowerCase() !== "github.com") return "";
    const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
    if (!owner || !repo) return "";
    return [owner, repo].map(encodeURIComponent).join("/");
  } catch {
    return "";
  }
}

export function buildGitHubRefArchiveUrl(repoUrl: string, ref: string) {
  const normalizedRepo = trim(repoUrl)
    .replace(/\.git$/i, "")
    .replace(/\/+$/g, "");
  const normalizedRef = trim(ref) || "main";
  const encodedRef = normalizedRef
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const codeloadRepo = resolveGitHubCodeloadRepoPath(normalizedRepo);
  if (codeloadRepo) {
    return `https://codeload.github.com/${codeloadRepo}/tar.gz/${encodedRef}`;
  }
  return `${normalizedRepo}/archive/${encodedRef}.tar.gz`;
}

export function buildGitHubBranchArchiveUrl(repoUrl: string, branch: string) {
  return buildGitHubRefArchiveUrl(repoUrl, `refs/heads/${branch}`);
}

export function buildNpmTarballUrl(packageName: string, version: string) {
  const normalizedName = trim(packageName) || DEFAULT_PACKAGE_NAME;
  const normalizedVersion = trim(version) || DEFAULT_STABLE_VERSION;
  const encodedName = encodeURIComponent(normalizedName);
  const fileBase = normalizedName.split("/").pop() || normalizedName;
  return `https://registry.npmjs.org/${encodedName}/-/${fileBase}-${normalizedVersion}.tgz`;
}
