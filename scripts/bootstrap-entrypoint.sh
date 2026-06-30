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
    NPM_ERROR='rin installer requires npm'
    NODE_ERROR='rin installer requires Node.js >= 22.19.0'
    ;;
  update)
    WORK_PREFIX=rin-update
    LOG_NAME=update.log
    MANIFEST_LABEL='Fetching release manifest'
    FETCH_LABEL='Fetching updater source'
    PREP_LABEL='Preparing updater source'
    BUILD_LABEL='Building updater'
    LAUNCH_LABEL='Launching updater...'
    FETCH_ERROR='rin updater requires curl or wget'
    NPM_ERROR='rin updater requires npm'
    NODE_ERROR='rin updater requires Node.js >= 22.19.0'
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
TTY=/dev/tty
CHANNEL=stable
BRANCH=
VERSION=
SOURCE_LABEL=
ARCHIVE_URL=
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
LOCAL_MANIFEST_PATH="$REPO_ROOT/release-manifest.json"

usage() {
  cat <<'EOF'
Usage: install.sh [--quick-run] [--stable] [--beta] [--nightly] [--git [main|deadbeef]] [legacy flags]

Install defaults to the stable release channel. Update defaults to the previously installed release channel.
`--quick-run` fetches the selected channel, prepares the current user's config, and launches the TUI without installing an app release or daemon.
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

read_launcher_install_dir() {
  launcher_path=$1
  if [ ! -r "$launcher_path" ]; then
    return 0
  fi
  node - "$launcher_path" 2>/dev/null <<'NODE' || true
const fs = require('node:fs');
try {
  const record = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) || {};
  process.stdout.write(String(record.defaultInstallDir || record.installDir || '').trim());
} catch {}
NODE
}

resolve_update_install_dir() {
  if [ -n "${RIN_DIR:-}" ]; then
    printf '%s' "$RIN_DIR"
    return 0
  fi
  home=${HOME:-}
  if [ -n "$home" ]; then
    for launcher_path in "$home/.config/rin/install.json" "$home/Library/Application Support/rin/install.json"; do
      launcher_install_dir=$(read_launcher_install_dir "$launcher_path")
      if [ -n "$launcher_install_dir" ]; then
        printf '%s' "$launcher_install_dir"
        return 0
      fi
    done
    printf '%s' "$home/.rin"
  fi
}

inherit_update_channel() {
  if [ "$MODE" != update ] || [ -n "${EXPLICIT_CHANNEL:-}" ]; then
    return 0
  fi
  install_dir=$(resolve_update_install_dir)
  manifest_path="$install_dir/installer.json"
  if [ -z "$install_dir" ] || [ ! -r "$manifest_path" ]; then
    echo "rin update requires an existing installer.json release record; pass --stable/--beta/--nightly/--git to override" >&2
    exit 1
  fi
  inherited=$(node - "$manifest_path" <<'NODE'
const fs = require('node:fs');
try {
  const release = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))?.currentRelease?.release || {};
  const channel = String(release.channel || '').trim();
  if (!['stable', 'beta', 'nightly', 'git'].includes(channel)) process.exit(0);
  const branch = channel === 'git' ? String(release.branch || '').trim() : '';
  process.stdout.write(`${channel}\n${branch}\n`);
} catch {}
NODE
)
  inherited_channel=$(printf '%s\n' "$inherited" | sed -n '1p')
  inherited_branch=$(printf '%s\n' "$inherited" | sed -n '2p')
  case "$inherited_channel" in
    stable|beta|nightly|git)
      CHANNEL=$inherited_channel
      if [ "$CHANNEL" = git ] && [ -z "$BRANCH" ] && [ -z "$VERSION" ] && [ -n "$inherited_branch" ]; then
        BRANCH=$inherited_branch
      fi
      ;;
    *)
      echo "rin update requires an existing installer.json release channel; pass --stable/--beta/--nightly/--git to override" >&2
      exit 1
      ;;
  esac
}

parse_args() {
  GIT_SELECTOR=
  EXPLICIT_CHANNEL=
  EXPECT_GIT_SELECTOR=
  QUICK_RUN=

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
        if [ "$MODE" != install ]; then
          echo "--quick-run is only supported by install.sh" >&2
          exit 1
        fi
        QUICK_RUN=1
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

  inherit_update_channel

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
  PRIMARY_URL="$RAW_BASE/$BOOTSTRAP_BRANCH/release-manifest.json"
  FALLBACK_URL="$RAW_BASE/main/release-manifest.json"
  if fetch "$PRIMARY_URL" "$MANIFEST_PATH"; then
    return 0
  fi
  if fetch "$FALLBACK_URL" "$MANIFEST_PATH"; then
    return 0
  fi
  if [ -r "$LOCAL_MANIFEST_PATH" ]; then
    cp "$LOCAL_MANIFEST_PATH" "$MANIFEST_PATH"
    return 0
  fi
  echo "failed to fetch release manifest" >&2
  exit 1
}

resolve_release() {
  node - "$MANIFEST_PATH" "$REPO_URL" "$PACKAGE_NAME" "$CHANNEL" "$BRANCH" "$VERSION" "$BOOTSTRAP_BRANCH" <<'NODE'
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const [manifestPath, repoArg, packageArg, channelArg, branchArg, versionArg, bootstrapBranchArg] = process.argv.slice(2);
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
  return `https://registry.npmjs.org/${encodedName}/-/${fileBase}-${releaseVersion || '0.0.0'}.tgz`;
};
const defaultManifest = {
  schemaVersion: 2,
  packageName,
  repoUrl,
  bootstrapBranch: trimValue(bootstrapBranchArg || 'bootstrap') || 'bootstrap',
  train: {
    series: '0.0',
    nightlyBranch: 'main',
  },
  stable: {
    version: '0.0.0',
    archiveUrl: buildNpmTarballUrl(packageName, '0.0.0'),
    ref: 'main',
  },
  beta: {
    version: '0.1.0-beta.0',
    archiveUrl: buildRefArchiveUrlForRepo(repoUrl, 'refs/heads/main'),
    ref: 'main',
    promotionVersion: '0.1.0',
  },
  nightly: {
    version: '0.1.0-nightly.0',
    archiveUrl: buildRefArchiveUrlForRepo(repoUrl, 'refs/heads/main'),
    ref: 'main',
    branch: 'main',
  },
  git: {
    defaultBranch: 'main',
    repoUrl,
  },
};
let manifest = defaultManifest;
try {
  manifest = { ...defaultManifest, ...JSON.parse(fs.readFileSync(manifestPath, 'utf8')) };
} catch {}
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
  const entry = version && manifest.stable && manifest.stable.versions ? manifest.stable.versions[version] : undefined;
  const resolvedVersion = version || trimValue(manifest.stable && manifest.stable.version) || '0.0.0';
  resolved = {
    channel: 'stable',
    archiveUrl: trimValue(entry && entry.archiveUrl) || trimValue(manifest.stable && manifest.stable.archiveUrl) || buildNpmTarballUrl(releasePackageName, resolvedVersion),
    version: resolvedVersion,
    branch: 'stable',
    ref: trimValue(entry && entry.ref) || trimValue(manifest.stable && manifest.stable.ref) || version || trimValue(manifest.stable && manifest.stable.version) || 'main',
    sourceLabel: version ? `stable version ${resolvedVersion}` : `stable ${resolvedVersion}`,
  };
} else if (channel === 'beta') {
  if (branch || version) throw new Error('rin_beta_selector_not_supported');
  const beta = manifest.beta || {};
  const resolvedRef = trimValue(beta.ref) || 'main';
  const resolvedVersion = trimValue(beta.version) || '0.1.0-beta.0';
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
  const nightly = manifest.nightly || {};
  const resolvedBranch = trimValue(nightly.branch) || trimValue(manifest.train && manifest.train.nightlyBranch) || 'main';
  const resolvedRef = trimValue(nightly.ref) || resolvedBranch;
  resolved = {
    channel: 'nightly',
    archiveUrl: trimValue(nightly.archiveUrl) || (trimValue(nightly.ref) ? buildRefArchiveUrl(resolvedRef) : buildBranchArchiveUrl(resolvedBranch)),
    version: trimValue(nightly.version) || '0.1.0-nightly.0',
    branch: resolvedBranch,
    ref: resolvedRef,
    sourceLabel: `nightly ${trimValue(nightly.version) || '0.1.0-nightly.0'}`,
  };
} else {
  const git = manifest.git || {};
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
  if [ -n "$QUICK_RUN" ]; then
    node "$INSTALLER_ENTRY" --release-file "$RELEASE_FILE" --quick-run
    return $?
  fi
  if [ "$MODE" = update ]; then
    node "$INSTALLER_ENTRY" --release-file "$RELEASE_FILE" --update
    return $?
  fi

  node "$INSTALLER_ENTRY" --release-file "$RELEASE_FILE"
}

INSTALLER_ENTRY='dist/app/rin-install/main.js'
PACKAGE_NAME='@hoshinorin/rin'
parse_args "$@"
adjust_quick_run_labels
check_node_version
: >"$LOGFILE"
run_step "$MANIFEST_LABEL" fetch_manifest
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
RELEASE_FILE="$WORKDIR/release.json"
node - "$RELEASE_FILE" "$CHANNEL" "$VERSION" "$BRANCH" "$REF" "$SOURCE_LABEL" "$ARCHIVE_URL" <<'NODE'
const fs = require('node:fs');
const [file, channel, version, branch, ref, sourceLabel, archiveUrl] = process.argv.slice(2);
fs.writeFileSync(file, `${JSON.stringify({ channel, version, branch, ref, sourceLabel, archiveUrl })}\n`, { mode: 0o600 });
NODE

run_step "$FETCH_LABEL" fetch "$ARCHIVE_URL" "$ARCHIVE"
mkdir -p "$SRC_DIR"
run_step "$PREP_LABEL" tar -xzf "$ARCHIVE" -C "$SRC_DIR" --strip-components=1

cd "$SRC_DIR"
if command -v npm >/dev/null 2>&1; then
  if [ "$CHANNEL" = stable ]; then
    node - <<'NODE'
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
    run_step "Installing dependencies" npm install --omit=dev --no-fund --no-audit
  elif [ -f package-lock.json ]; then
    run_step "Installing dependencies" npm ci --no-fund --no-audit
  else
    run_step "Installing dependencies" npm install --no-fund --no-audit
  fi
else
  echo "$NPM_ERROR" >&2
  exit 1
fi

if [ "$CHANNEL" != stable ]; then
  run_step "$BUILD_LABEL" npm run build
  run_step "Pruning dependencies" npm prune --omit=dev --no-fund --no-audit
fi
say "$LAUNCH_LABEL"

if has_tty; then
  launch_installer_entry </dev/tty >/dev/tty 2>&1
  exit $?
fi

launch_installer_entry
