#!/bin/sh
set -eu

MODE=${1:-install}
case "$MODE" in
  install)
    WORK_PREFIX=rin-install
    LOG_NAME=install.log
    MANIFEST_LABEL='Fetching release manifest'
    FETCH_LABEL='Fetching installer source'
    PREP_LABEL='Preparing installer source'
    BUILD_LABEL='Building installer'
    LAUNCH_LABEL='Launching installer...'
    FETCH_ERROR='rin installer requires curl or wget'
    NODE_ERROR='rin installer requires Node.js >= 22.19.0'
    ;;
  *)
    echo "unknown Rin bootstrap mode: $MODE" >&2
    exit 64
    ;;
esac
shift || true

REPO_URL=${RIN_INSTALL_REPO_URL:-https://github.com/rinchan-hoshino/rin}
BOOTSTRAP_BRANCH=${RIN_BOOTSTRAP_BRANCH:-bootstrap}
CACHE_BASE=${XDG_CACHE_HOME:-${HOME:-/tmp}/.cache}
TMPDIR_BASE=${TMPDIR:-$CACHE_BASE/rin-install}
mkdir -p "$TMPDIR_BASE"
WORKDIR=$(mktemp -d "$TMPDIR_BASE/$WORK_PREFIX.XXXXXX")
ARCHIVE="$WORKDIR/rin.tar.gz"
SRC_DIR="$WORKDIR/src"
LOGFILE="$WORKDIR/$LOG_NAME"
MANIFEST_PATH="$WORKDIR/release-manifest.json"
ASSETS_ENV="$WORKDIR/release-assets.env"
TTY=/dev/tty
CHANNEL=stable
BRANCH=
VERSION=
SOURCE_LABEL=
ARCHIVE_URL=
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
LOCAL_MANIFEST_PATH="$REPO_ROOT/release-manifest.json"
MANAGED_NPM_VERSION=10.9.3
MANAGED_NPM_SHA512=e84875bb943e908557780f1eee5d9cfc7a67145730ae4b77ef10ccba30f96ded6096859af69ea3dc5b2fde60725d79aa247cbed9c12544c30bf28a4d4fbc4825

usage() {
  cat <<'EOF'
Usage: install.sh [--quick-run] [--no-start] [--stable] [--beta] [--nightly] [--git [main|deadbeef]] [legacy flags]

Install defaults to the stable release channel.
`--quick-run` fetches the selected channel, prepares the current user's config, and launches the TUI without installing an app release or daemon.
`--no-start` installs the managed service definition without starting the daemon; run `rin start` when ready.
`--beta` installs the current weekly beta candidate.
`--nightly` installs the current nightly build.
`--git main` or `--git deadbeef` selects a branch or ref directly.
Legacy flags such as --branch/--version remain supported.
EOF
}

cleanup() {
  rm -rf "$WORKDIR"
}
trap cleanup EXIT INT TERM

has_tty() {
  [ -r "$TTY" ] 2>/dev/null && [ -w "$TTY" ] 2>/dev/null && (: <"$TTY" >"$TTY") >/dev/null 2>&1
}

say() {
  if has_tty; then
    printf '%s\n' "$1" >"$TTY"
  else
    printf '%s\n' "$1"
  fi
}

check_node_version() {
  if ! command -v node >/dev/null 2>&1; then
    echo "$NODE_ERROR" >&2
    exit 1
  fi
  if ! node -e '
const min = process.argv[1].split(".").map(Number);
const current = process.versions.node.split(".").map(Number);
for (let i = 0; i < min.length; i += 1) {
  if ((current[i] || 0) > min[i]) process.exit(0);
  if ((current[i] || 0) < min[i]) process.exit(1);
}
' 22.19.0 >/dev/null 2>&1; then
    echo "$NODE_ERROR" >&2
    exit 1
  fi
}

render_spinner() {
  label=$1
  pid=$2
  i=0
  while kill -0 "$pid" 2>/dev/null; do
    case $i in
      0) frame='⠋' ;;
      1) frame='⠙' ;;
      2) frame='⠹' ;;
      3) frame='⠸' ;;
      4) frame='⠼' ;;
      5) frame='⠴' ;;
      6) frame='⠦' ;;
      7) frame='⠧' ;;
      8) frame='⠇' ;;
      *) frame='⠏' ;;
    esac
    if has_tty; then
      printf '\r%s %s' "$frame" "$label" >"$TTY"
    fi
    i=$(( (i + 1) % 10 ))
    sleep 0.1
  done
}

run_step() {
  label=$1
  shift
  : >>"$LOGFILE"
  "$@" >>"$LOGFILE" 2>&1 &
  pid=$!
  render_spinner "$label" "$pid"
  set +e
  wait "$pid"
  status=$?
  set -e
  if has_tty; then
    if [ "$status" -eq 0 ]; then
      printf '\r✓ %s\033[K\n' "$label" >"$TTY"
    else
      printf '\r✗ %s\033[K\n' "$label" >"$TTY"
    fi
  fi
  if [ "$status" -ne 0 ]; then
    say "Command failed; recent log:"
    tail -n 80 "$LOGFILE" >&2 || true
    exit "$status"
  fi
}

fetch() {
  URL=$1
  OUT=$2
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$URL" -o "$OUT"
    return 0
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -qO "$OUT" "$URL"
    return 0
  fi
  echo "$FETCH_ERROR" >&2
  exit 1
}

looks_like_git_ref() {
  case "$1" in
    refs/*|v[0-9]*|*~*|*^*|*:*) return 0 ;;
  esac
  printf '%s' "$1" | grep -Eq '^[0-9a-fA-F]{7,40}$'
}

read_option_value() {
  option=$1
  shift
  if [ "$#" -lt 1 ] || [ -z "${1:-}" ] || [ "${1#-}" != "$1" ]; then
    echo "missing value for $option" >&2
    exit 1
  fi
  OPTION_VALUE=$1
}

parse_args() {
  GIT_SELECTOR=
  EXPLICIT_CHANNEL=
  EXPECT_GIT_SELECTOR=
  QUICK_RUN=
  NO_START=

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --stable)
        if [ -n "$EXPLICIT_CHANNEL" ] && [ "$EXPLICIT_CHANNEL" != stable ]; then
          echo "cannot combine conflicting release channel selectors" >&2
          exit 1
        fi
        CHANNEL=stable
        EXPLICIT_CHANNEL=stable
        EXPECT_GIT_SELECTOR=
        ;;
      --beta)
        if [ -n "$EXPLICIT_CHANNEL" ] && [ "$EXPLICIT_CHANNEL" != beta ]; then
          echo "cannot combine conflicting release channel selectors" >&2
          exit 1
        fi
        CHANNEL=beta
        EXPLICIT_CHANNEL=beta
        EXPECT_GIT_SELECTOR=
        ;;
      --nightly)
        if [ -n "$EXPLICIT_CHANNEL" ] && [ "$EXPLICIT_CHANNEL" != nightly ]; then
          echo "cannot combine conflicting release channel selectors" >&2
          exit 1
        fi
        CHANNEL=nightly
        EXPLICIT_CHANNEL=nightly
        EXPECT_GIT_SELECTOR=
        ;;
      --git)
        if [ -n "$EXPLICIT_CHANNEL" ] && [ "$EXPLICIT_CHANNEL" != git ]; then
          echo "cannot combine conflicting release channel selectors" >&2
          exit 1
        fi
        CHANNEL=git
        EXPLICIT_CHANNEL=git
        EXPECT_GIT_SELECTOR=1
        ;;
      --branch)
        EXPECT_GIT_SELECTOR=
        read_option_value --branch "$@"
        BRANCH=$OPTION_VALUE
        shift
        ;;
      --version)
        EXPECT_GIT_SELECTOR=
        read_option_value --version "$@"
        VERSION=$OPTION_VALUE
        shift
        ;;
      --quick-run)
        QUICK_RUN=1
        EXPECT_GIT_SELECTOR=
        ;;
      --no-start)
        NO_START=1
        EXPECT_GIT_SELECTOR=
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        if [ -n "$EXPECT_GIT_SELECTOR" ] && [ -z "$GIT_SELECTOR" ] && [ "${1#-}" = "$1" ]; then
          GIT_SELECTOR=$1
          EXPECT_GIT_SELECTOR=
        elif [ "$CHANNEL" = stable ]; then
          echo "stable does not support a flag selector" >&2
          exit 1
        elif [ "$CHANNEL" = beta ]; then
          echo "beta does not support a flag selector" >&2
          exit 1
        elif [ "$CHANNEL" = nightly ]; then
          echo "nightly does not support a flag selector" >&2
          exit 1
        else
          echo "unknown argument: $1" >&2
          usage >&2
          exit 1
        fi
        ;;
    esac
    shift
  done

  if [ -z "$BRANCH" ] && [ -z "$VERSION" ] && [ -n "$GIT_SELECTOR" ]; then
    if looks_like_git_ref "$GIT_SELECTOR"; then
      VERSION=$GIT_SELECTOR
    else
      BRANCH=$GIT_SELECTOR
    fi
  fi


  if [ -n "$BRANCH" ] && [ -n "$VERSION" ]; then
    echo "cannot combine --branch and --version" >&2
    exit 1
  fi
  if [ "$CHANNEL" = stable ] && [ -n "$BRANCH" ]; then
    echo "stable does not support --branch" >&2
    exit 1
  fi
  if [ "$CHANNEL" = beta ] && { [ -n "$BRANCH" ] || [ -n "$VERSION" ]; }; then
    echo "beta does not support explicit selectors" >&2
    exit 1
  fi
  if [ "$CHANNEL" = nightly ] && { [ -n "$BRANCH" ] || [ -n "$VERSION" ]; }; then
    echo "nightly does not support explicit selectors" >&2
    exit 1
  fi
}

adjust_quick_run_labels() {
  if [ -n "$QUICK_RUN" ]; then
    LAUNCH_LABEL='Launching Rin quick run...'
  fi
}

fetch_manifest() {
  RAW_BASE=$(printf '%s' "$REPO_URL" | sed -e 's#^https://github.com/#https://raw.githubusercontent.com/#' -e 's#\.git$##')
  MANIFEST_URL="$RAW_BASE/$BOOTSTRAP_BRANCH/release-manifest.json"
  if fetch "$MANIFEST_URL" "$MANIFEST_PATH"; then
    return 0
  fi
  if [ -r "$LOCAL_MANIFEST_PATH" ]; then
    cp "$LOCAL_MANIFEST_PATH" "$MANIFEST_PATH"
    return 0
  fi
  echo "failed to fetch release manifest" >&2
  exit 1
}

fetch_assets_env() {
  RAW_BASE=$(printf '%s' "$REPO_URL" | sed -e 's#^https://github.com/#https://raw.githubusercontent.com/#' -e 's#\.git$##')
  ASSETS_URL="$RAW_BASE/$BOOTSTRAP_BRANCH/release-assets.env"
  if fetch "$ASSETS_URL" "$ASSETS_ENV"; then
    return 0
  fi
  if [ -r "$REPO_ROOT/release-assets.env" ]; then
    cp "$REPO_ROOT/release-assets.env" "$ASSETS_ENV"
    return 0
  fi
  : >"$ASSETS_ENV"
}

load_assets_env() {
  if [ ! -r "$ASSETS_ENV" ]; then
    return 0
  fi
  has_asset=0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    if ! printf '%s\n' "$line" | grep -Eq "^RIN_ASSET_[A-Z0-9_]+='[^']*'$"; then
      echo "ignoring invalid Rin release assets file" >&2
      return 0
    fi
    has_asset=1
  done <"$ASSETS_ENV"
  if [ "$has_asset" -eq 1 ]; then
    # release-assets.env is generated from release-manifest.json by Rin's release tooling.
    . "$ASSETS_ENV"
  fi
}

env_key() {
  printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | sed 's/[^A-Z0-9]/_/g; s/^_*//; s/_*$//'
}

detect_platform_key() {
  os_name=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')
  arch_name=$(uname -m 2>/dev/null | tr '[:upper:]' '[:lower:]')
  case "$os_name" in
    linux*) os_name=linux ;;
    darwin*) os_name=darwin ;;
    msys*|mingw*|cygwin*) os_name=win32 ;;
  esac
  case "$arch_name" in
    x86_64|amd64) arch_name=x64 ;;
    aarch64|arm64) arch_name=arm64 ;;
  esac
  printf '%s-%s' "$os_name" "$arch_name"
}

asset_value() {
  eval "printf '%s' \"\${$1:-}\""
}

select_platform_asset_release() {
  if [ "$CHANNEL" = git ] || [ -n "$BRANCH" ] || [ -n "$VERSION" ]; then
    return 1
  fi
  platform_key=$(detect_platform_key)
  prefix="RIN_ASSET_$(env_key "$CHANNEL")_$(env_key "$platform_key")"
  asset_url=$(asset_value "${prefix}_URL")
  if [ -z "$asset_url" ]; then
    return 1
  fi
  CHANNEL=${CHANNEL:-stable}
  ARCHIVE_URL=$asset_url
  VERSION=$(asset_value "${prefix}_VERSION")
  BRANCH=$(asset_value "${prefix}_BRANCH")
  REF=$(asset_value "${prefix}_REF")
  SOURCE_LABEL=$(asset_value "${prefix}_SOURCE_LABEL")
  ASSET_SHA256=$(asset_value "${prefix}_SHA256")
  VERSION=${VERSION:-unknown}
  BRANCH=${BRANCH:-$CHANNEL}
  SOURCE_LABEL=${SOURCE_LABEL:-$CHANNEL $VERSION}
  return 0
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

write_release_file_shell() {
  printf '{"channel":"%s","version":"%s","branch":"%s","ref":"%s","sourceLabel":"%s","archiveUrl":"%s"}\n' \
    "$(json_escape "$CHANNEL")" \
    "$(json_escape "$VERSION")" \
    "$(json_escape "$BRANCH")" \
    "$(json_escape "$REF")" \
    "$(json_escape "$SOURCE_LABEL")" \
    "$(json_escape "$ARCHIVE_URL")" >"$RELEASE_FILE"
}

archive_path_for_url() {
  case "$1" in
    *.zip|*.zip\?*|*.zip#*) printf '%s' "$WORKDIR/rin.zip" ;;
    *) printf '%s' "$ARCHIVE" ;;
  esac
}

verify_archive_sha256() {
  expected=$1
  file=$2
  if [ -z "$expected" ]; then
    echo "rin bootstrap platform bundle checksum is missing" >&2
    exit 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$file" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$file" | awk '{print $1}')
  else
    echo "rin bootstrap requires sha256sum or shasum to verify platform bundle" >&2
    exit 1
  fi
  if [ "$actual" != "$expected" ]; then
    echo "rin bootstrap platform bundle checksum mismatch" >&2
    exit 1
  fi
}

verify_managed_npm_archive() {
  file=$1
  if command -v sha512sum >/dev/null 2>&1; then
    actual=$(sha512sum "$file" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 512 "$file" | awk '{print $1}')
  else
    echo "rin bootstrap requires sha512sum or shasum to verify managed npm" >&2
    exit 1
  fi
  if [ "$actual" != "$MANAGED_NPM_SHA512" ]; then
    echo "rin managed npm checksum mismatch" >&2
    return 1
  fi
}

extract_archive() {
  archive=$1
  dest=$2
  case "$archive" in
    *.zip)
      if command -v unzip >/dev/null 2>&1; then
        zip_root="$WORKDIR/zip-extract"
        rm -rf "$zip_root"
        mkdir -p "$zip_root" "$dest"
        unzip -q "$archive" -d "$zip_root"
        child_count=$(find "$zip_root" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' ')
        copy_root="$zip_root"
        if [ "$child_count" = 1 ]; then
          first_child=$(find "$zip_root" -mindepth 1 -maxdepth 1 -print | sed -n '1p')
          if [ -d "$first_child" ]; then
            copy_root="$first_child"
          fi
        fi
        cp -R "$copy_root"/. "$dest"/
      else
        echo "rin bootstrap requires unzip for zip platform bundles" >&2
        exit 1
      fi
      ;;
    *)
      tar -xzf "$archive" -C "$dest" --strip-components=1
      ;;
  esac
}

find_bundled_node() {
  for candidate in \
    "$SRC_DIR/runtime/node/current/bin/node" \
    "$SRC_DIR/runtime/node/current/node.exe"
  do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  echo "rin platform bundle is missing runtime/node/current" >&2
  exit 1
}

find_bundled_npm_cli() {
  for candidate in \
    "$SRC_DIR/runtime/node/current/lib/node_modules/npm/bin/npm-cli.js" \
    "$SRC_DIR/runtime/node/current/node_modules/npm/bin/npm-cli.js"
  do
    if [ -f "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  echo "rin managed node runtime is missing npm" >&2
  exit 1
}

provision_source_managed_node() {
  target_root="$SRC_DIR/runtime/node/current"
  target_node="$target_root/bin/node"
  target_npm_root="$target_root/lib/node_modules/npm"
  target_npm_cli="$target_npm_root/bin/npm-cli.js"
  if [ -x "$target_node" ] && [ -f "$target_npm_cli" ] &&
    NODE_PATH= PATH="$target_root/bin" "$target_node" "$target_npm_cli" --version >/dev/null 2>&1
  then
    return 0
  fi
  copied_source_node=
  if [ ! -x "$target_node" ]; then
    node_path=$(command -v node 2>/dev/null || true)
    if [ -z "$node_path" ] || [ ! -x "$node_path" ]; then
      echo "$NODE_ERROR" >&2
      exit 1
    fi
    rm -rf "$target_root"
    mkdir -p "$target_root/bin" "$target_root/lib/node_modules"
    cp "$node_path" "$target_node"
    chmod 0755 "$target_node"
    copied_source_node=1
  else
    mkdir -p "$target_root/bin" "$target_root/lib/node_modules"
  fi

  if [ -n "$copied_source_node" ]; then
    node_bin_dir=$(dirname "$node_path")
    if [ "$(basename "$node_bin_dir")" = bin ]; then
      node_root=$(dirname "$node_bin_dir")
    else
      node_root=$node_bin_dir
    fi
    npm_root="$node_root/lib/node_modules/npm"
    if [ -d "$npm_root" ]; then
      cp -RL "$npm_root" "$target_npm_root"
      ln -s ../lib/node_modules/npm/bin/npm-cli.js "$target_root/bin/npm"
      ln -s ../lib/node_modules/npm/bin/npx-cli.js "$target_root/bin/npx"
    fi
  fi

  if [ ! -f "$target_npm_cli" ] ||
    ! NODE_PATH= PATH="$target_root/bin" "$target_node" "$target_npm_cli" --version >/dev/null 2>&1
  then
    rm -rf "$target_npm_root" "$target_root/bin/npm" "$target_root/bin/npx"
    npm_archive="$CACHE_BASE/rin/node-toolchain/npm-$MANAGED_NPM_VERSION.tgz"
    mkdir -p "$(dirname "$npm_archive")"
    if [ -f "$npm_archive" ]; then
      if ! verify_managed_npm_archive "$npm_archive"; then
        rm -f "$npm_archive"
      fi
    fi
    if [ ! -f "$npm_archive" ]; then
      temporary_archive="$npm_archive.$$.tmp"
      if ! fetch "https://registry.npmjs.org/npm/-/npm-$MANAGED_NPM_VERSION.tgz" "$temporary_archive"; then
        rm -f "$temporary_archive"
        exit 1
      fi
      if ! verify_managed_npm_archive "$temporary_archive"; then
        rm -f "$temporary_archive"
        exit 1
      fi
      mv -f "$temporary_archive" "$npm_archive"
    fi
    verify_managed_npm_archive "$npm_archive"
    npm_extract="$WORKDIR/managed-npm"
    rm -rf "$npm_extract"
    mkdir -p "$npm_extract"
    tar -xzf "$npm_archive" -C "$npm_extract"
    cp -R "$npm_extract/package" "$target_npm_root"
    ln -s ../lib/node_modules/npm/bin/npm-cli.js "$target_root/bin/npm"
    ln -s ../lib/node_modules/npm/bin/npx-cli.js "$target_root/bin/npx"
  fi

  if ! NODE_PATH= PATH="$target_root/bin" "$target_node" "$target_npm_cli" --version >/dev/null 2>&1; then
    echo "rin managed node runtime is missing a self-contained npm" >&2
    exit 1
  fi
}

resolve_release() {
  node - "$MANIFEST_PATH" "$REPO_URL" "$PACKAGE_NAME" "$CHANNEL" "$BRANCH" "$VERSION" <<'NODE'
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const [manifestPath, repoArg, packageArg, channelArg, branchArg, versionArg] = process.argv.slice(2);
const safeString = (value) => (value == null ? '' : String(value));
const trimValue = (value) => safeString(value).trim();
const repoUrl = trimValue(repoArg || 'https://github.com/rinchan-hoshino/rin').replace(/\.git$/i, '').replace(/\/+$/g, '');
const packageName = trimValue(packageArg || '@hoshinorin/rin');
const channel = trimValue(channelArg || 'stable').toLowerCase() || 'stable';
const branch = trimValue(branchArg);
const version = trimValue(versionArg);
const encodePath = (value) => String(value || 'main').split('/').map(encodeURIComponent).join('/');
const githubCodeloadRepoPath = (value) => {
  const normalized = trimValue(value).replace(/\.git$/i, '').replace(/\/+$/g, '');
  const sshMatch = /^git@github\.com:([^/]+)\/([^/]+)$/i.exec(normalized);
  if (sshMatch && sshMatch[1] && sshMatch[2]) return [sshMatch[1], sshMatch[2]].map(encodeURIComponent).join('/');
  try {
    const parsed = new URL(normalized);
    if (parsed.hostname.toLowerCase() !== 'github.com') return '';
    const [owner, repo] = parsed.pathname.split('/').filter(Boolean);
    if (!owner || !repo) return '';
    return [owner, repo].map(encodeURIComponent).join('/');
  } catch {
    return '';
  }
};
const buildRefArchiveUrlForRepo = (repo, ref) => {
  const normalizedRepo = trimValue(repo).replace(/\.git$/i, '').replace(/\/+$/g, '');
  const encodedRef = encodePath(ref);
  const codeloadRepo = githubCodeloadRepoPath(normalizedRepo);
  return codeloadRepo ? `https://codeload.github.com/${codeloadRepo}/tar.gz/${encodedRef}` : `${normalizedRepo}/archive/${encodedRef}.tar.gz`;
};
const buildNpmTarballUrl = (name, releaseVersion) => {
  const encodedName = encodeURIComponent(name || '@hoshinorin/rin');
  const fileBase = String(name || '@hoshinorin/rin').split('/').pop();
  return `https://registry.npmjs.org/${encodedName}/-/${fileBase}-${releaseVersion}.tgz`;
};
const invalidManifest = (detail) => {
  console.error(`invalid Rin release manifest: ${detail}`);
  process.exit(1);
};
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch {
  invalidManifest('expected readable JSON');
}
if (!isRecord(manifest)) invalidManifest('expected an object');
if (!isRecord(manifest[channel])) invalidManifest(`missing ${channel} release`);
const releaseRepoUrl = trimValue(manifest.repoUrl || repoUrl).replace(/\.git$/i, '').replace(/\/+$/g, '');
const releasePackageName = trimValue(manifest.packageName || packageName) || '@hoshinorin/rin';
const buildRefArchiveUrl = (ref) => buildRefArchiveUrlForRepo(releaseRepoUrl, ref);
const buildBranchArchiveUrl = (name) => buildRefArchiveUrlForRepo(releaseRepoUrl, `refs/heads/${name || 'main'}`);
const isGitHash = (value) => /^[0-9a-f]{7,40}$/i.test(trimValue(value));
const gitHubRepoParts = (value) => {
  const normalized = trimValue(value).replace(/\.git$/i, '').replace(/\/+$/g, '');
  const sshMatch = /^git@github\.com:([^/]+)\/([^/]+)$/i.exec(normalized);
  if (sshMatch && sshMatch[1] && sshMatch[2]) return [sshMatch[1], sshMatch[2]];
  try {
    const parsed = new URL(normalized);
    if (parsed.hostname.toLowerCase() !== 'github.com') return [];
    const [owner, repo] = parsed.pathname.split('/').filter(Boolean);
    return owner && repo ? [owner, repo] : [];
  } catch {
    return [];
  }
};
const resolveGitCommit = (selector, branchSelector) => {
  const normalizedSelector = trimValue(selector || branchSelector || 'HEAD');
  if (/^[0-9a-f]{40}$/i.test(normalizedSelector)) return normalizedSelector;
  const lsRemoteSelectors = branchSelector
    ? [`refs/heads/${branchSelector}`, branchSelector]
    : [normalizedSelector];
  for (const item of lsRemoteSelectors) {
    try {
      const raw = execFileSync('git', ['ls-remote', releaseRepoUrl, item], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const hash = String(raw).split(/\s+/)[0] || '';
      if (/^[0-9a-f]{40}$/i.test(hash)) return hash;
    } catch {}
  }
  const [owner, repo] = gitHubRepoParts(releaseRepoUrl);
  if (owner && repo) {
    try {
      const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(normalizedSelector)}`;
      const raw = execFileSync('curl', ['-fsSL', apiUrl], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const sha = trimValue(JSON.parse(raw).sha);
      if (/^[0-9a-f]{40}$/i.test(sha)) return sha;
    } catch {}
  }
  if (isGitHash(normalizedSelector)) return normalizedSelector;
  throw new Error(`rin_git_ref_not_resolved:${normalizedSelector}`);
};
const shellEscape = (value) => `'${String(value ?? '').replace(/'/g, `"'"'"'`)}'`;
let resolved;
if (branch && version) throw new Error('rin_release_branch_and_version_conflict');
if (channel === 'stable') {
  if (branch) throw new Error('rin_stable_branch_not_supported');
  const stable = manifest.stable;
  const entry = version && isRecord(stable.versions) ? stable.versions[version] : undefined;
  const resolvedVersion = version || trimValue(stable.version);
  if (!resolvedVersion) invalidManifest('missing stable release version');
  resolved = {
    channel: 'stable',
    archiveUrl: trimValue(entry && entry.archiveUrl) || trimValue(stable.archiveUrl) || buildNpmTarballUrl(releasePackageName, resolvedVersion),
    version: resolvedVersion,
    branch: 'stable',
    ref: trimValue(entry && entry.ref) || trimValue(stable.ref) || version || resolvedVersion,
    sourceLabel: version ? `stable version ${resolvedVersion}` : `stable ${resolvedVersion}`,
  };
} else if (channel === 'beta') {
  if (branch || version) throw new Error('rin_beta_selector_not_supported');
  const beta = manifest.beta;
  const resolvedRef = trimValue(beta.ref) || 'main';
  const resolvedVersion = trimValue(beta.version);
  if (!resolvedVersion) invalidManifest('missing beta release version');
  resolved = {
    channel: 'beta',
    archiveUrl: trimValue(beta.archiveUrl) || buildRefArchiveUrl(resolvedRef),
    version: resolvedVersion,
    branch: 'beta',
    ref: resolvedRef,
    sourceLabel: `beta ${resolvedVersion}`,
  };
} else if (channel === 'nightly') {
  if (branch || version) throw new Error('rin_nightly_selector_not_supported');
  const nightly = manifest.nightly;
  const resolvedVersion = trimValue(nightly.version);
  if (!resolvedVersion) invalidManifest('missing nightly release version');
  const resolvedBranch = trimValue(nightly.branch) || trimValue(manifest.train && manifest.train.nightlyBranch) || 'main';
  const resolvedRef = trimValue(nightly.ref) || resolvedBranch;
  resolved = {
    channel: 'nightly',
    archiveUrl: trimValue(nightly.archiveUrl) || (trimValue(nightly.ref) ? buildRefArchiveUrl(resolvedRef) : buildBranchArchiveUrl(resolvedBranch)),
    version: resolvedVersion,
    branch: resolvedBranch,
    ref: resolvedRef,
    sourceLabel: `nightly ${resolvedVersion}`,
  };
} else {
  const git = manifest.git;
  const resolvedBranch = branch || trimValue(git.defaultBranch) || 'main';
  const selector = version || resolvedBranch;
  const resolvedRef = resolveGitCommit(selector, version ? '' : resolvedBranch);
  const shortRef = resolvedRef.slice(0, 12);
  resolved = {
    channel: 'git',
    archiveUrl: buildRefArchiveUrl(resolvedRef),
    version: shortRef,
    branch: resolvedBranch,
    ref: resolvedRef,
    sourceLabel: `git ${resolvedBranch} @ ${shortRef}`,
  };
}
for (const [key, value] of Object.entries({
  PACKAGE_NAME: releasePackageName,
  CHANNEL: resolved.channel,
  ARCHIVE_URL: resolved.archiveUrl,
  VERSION: resolved.version,
  BRANCH: resolved.branch,
  REF: resolved.ref,
  SOURCE_LABEL: resolved.sourceLabel,
})) {
  console.log(`${key}=${shellEscape(value)}`);
}
NODE
}

launch_installer_entry() {
  node_command=${NODE_COMMAND:-node}
  if [ -n "$QUICK_RUN" ]; then
    "$node_command" "$INSTALLER_ENTRY" --release-file "$RELEASE_FILE" --quick-run
    return $?
  fi
  if [ -n "$NO_START" ]; then
    "$node_command" "$INSTALLER_ENTRY" --release-file "$RELEASE_FILE" --no-start
    return $?
  fi
  "$node_command" "$INSTALLER_ENTRY" --release-file "$RELEASE_FILE"
}

INSTALLER_ENTRY='dist/app/rin-install/main.js'
PACKAGE_NAME='@hoshinorin/rin'
parse_args "$@"
adjust_quick_run_labels
: >"$LOGFILE"
run_step "$MANIFEST_LABEL" fetch_manifest
fetch_assets_env || true
load_assets_env
RELEASE_FILE="$WORKDIR/release.json"
if select_platform_asset_release; then
  write_release_file_shell
  PLATFORM_ARCHIVE=$(archive_path_for_url "$ARCHIVE_URL")
  run_step "$FETCH_LABEL" fetch "$ARCHIVE_URL" "$PLATFORM_ARCHIVE"
  verify_archive_sha256 "${ASSET_SHA256:-}" "$PLATFORM_ARCHIVE"
  mkdir -p "$SRC_DIR"
  run_step "$PREP_LABEL" extract_archive "$PLATFORM_ARCHIVE" "$SRC_DIR"
  NODE_COMMAND=$(find_bundled_node)
  NPM_CLI=$(find_bundled_npm_cli)
  PATH="$(dirname "$NODE_COMMAND"):$PATH"
  NODE_PATH=
  export PATH NODE_PATH
  cd "$SRC_DIR"
  run_step "Verifying managed npm" "$NODE_COMMAND" "$NPM_CLI" --version
  run_step "Verifying native dependencies" "$NODE_COMMAND" -e "const Database=require('better-sqlite3');const db=new Database(':memory:');db.prepare('select 1').get();db.close();"
  say "$LAUNCH_LABEL"
  if has_tty; then
    launch_installer_entry </dev/tty >/dev/tty 2>&1
    exit $?
  fi
  launch_installer_entry
  exit $?
fi

check_node_version
RELEASE_ENV="$WORKDIR/release.env"
RELEASE_ERROR="$WORKDIR/release.err"
set +e
resolve_release >"$RELEASE_ENV" 2>"$RELEASE_ERROR"
resolve_status=$?
set -e
if [ "$resolve_status" -ne 0 ]; then
  unresolved_ref=$(sed -n 's/^Error: rin_git_ref_not_resolved:\([^[:space:]]*\).*/\1/p' "$RELEASE_ERROR" | head -n 1)
  if [ -n "$unresolved_ref" ]; then
    echo "failed to resolve git ref: $unresolved_ref" >&2
  else
    cat "$RELEASE_ERROR" >&2 || true
  fi
  exit "$resolve_status"
fi
eval "$(cat "$RELEASE_ENV")"
PACKAGE_NAME=${PACKAGE_NAME:-@hoshinorin/rin}
node - "$RELEASE_FILE" "$CHANNEL" "$VERSION" "$BRANCH" "$REF" "$SOURCE_LABEL" "$ARCHIVE_URL" <<'NODE'
const fs = require('node:fs');
const [file, channel, version, branch, ref, sourceLabel, archiveUrl] = process.argv.slice(2);
fs.writeFileSync(file, `${JSON.stringify({ channel, version, branch, ref, sourceLabel, archiveUrl })}\n`, { mode: 0o600 });
NODE

run_step "$FETCH_LABEL" fetch "$ARCHIVE_URL" "$ARCHIVE"
mkdir -p "$SRC_DIR"
run_step "$PREP_LABEL" extract_archive "$ARCHIVE" "$SRC_DIR"

cd "$SRC_DIR"
provision_source_managed_node
NODE_COMMAND=$(find_bundled_node)
NPM_CLI=$(find_bundled_npm_cli)
PATH="$(dirname "$NODE_COMMAND"):$PATH"
NODE_PATH=
export PATH NODE_PATH
if [ "$CHANNEL" = stable ]; then
  "$NODE_COMMAND" - <<'NODE'
const fs = require('node:fs');
const file = 'package.json';
try {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed && parsed.scripts && parsed.scripts.prepare) {
    delete parsed.scripts.prepare;
    fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  }
} catch {}
NODE
  run_step "Installing dependencies" "$NODE_COMMAND" "$NPM_CLI" install --omit=dev --no-fund --no-audit
elif [ -f package-lock.json ]; then
  run_step "Installing dependencies" "$NODE_COMMAND" "$NPM_CLI" ci --no-fund --no-audit
else
  run_step "Installing dependencies" "$NODE_COMMAND" "$NPM_CLI" install --no-fund --no-audit
fi

if [ "$CHANNEL" != stable ]; then
  run_step "$BUILD_LABEL" "$NODE_COMMAND" "$NPM_CLI" run build
  run_step "Pruning dependencies" "$NODE_COMMAND" "$NPM_CLI" prune --omit=dev --no-fund --no-audit
fi
run_step "Verifying native dependencies" "$NODE_COMMAND" -e "const Database=require('better-sqlite3');const db=new Database(':memory:');db.prepare('select 1').get();db.close();"
say "$LAUNCH_LABEL"

if has_tty; then
  launch_installer_entry </dev/tty >/dev/tty 2>&1
  exit $?
fi

launch_installer_entry
