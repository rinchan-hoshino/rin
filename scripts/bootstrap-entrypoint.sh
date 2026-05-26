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
Usage: install.sh [--stable] [--beta] [--nightly] [--git [main|deadbeef]] [legacy flags]

Defaults to the stable release channel.
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
const [manifestPath, repoArg, packageArg, channelArg, branchArg, versionArg, bootstrapBranchArg] = process.argv.slice(2);
const safeString = (value) => (value == null ? '' : String(value));
const trimValue = (value) => safeString(value).trim();
const repoUrl = trimValue(repoArg || 'https://github.com/rinchan-hoshino/rin').replace(/\.git$/i, '');
const packageName = trimValue(packageArg || '@hoshinorin/rin');
const channel = trimValue(channelArg || 'stable').toLowerCase() || 'stable';
const branch = trimValue(branchArg);
const version = trimValue(versionArg);
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
    archiveUrl: `${repoUrl}/archive/refs/heads/main.tar.gz`,
    ref: 'main',
    promotionVersion: '0.1.0',
  },
  nightly: {
    version: '0.1.0-nightly.0',
    archiveUrl: `${repoUrl}/archive/refs/heads/main.tar.gz`,
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
const releaseRepoUrl = trimValue(manifest.repoUrl || repoUrl).replace(/\.git$/i, '');
const releasePackageName = trimValue(manifest.packageName || packageName) || '@hoshinorin/rin';
const buildRefArchiveUrl = (ref) => `${releaseRepoUrl}/archive/${String(ref || 'main').split('/').map(encodeURIComponent).join('/')}.tar.gz`;
const buildBranchArchiveUrl = (name) => `${releaseRepoUrl}/archive/refs/heads/${String(name || 'main').split('/').map(encodeURIComponent).join('/')}.tar.gz`;
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
  const resolvedRef = version || resolvedBranch;
  resolved = {
    channel: 'git',
    archiveUrl: version ? buildRefArchiveUrl(resolvedRef) : buildBranchArchiveUrl(resolvedBranch),
    version: version || resolvedRef,
    branch: resolvedBranch,
    ref: resolvedRef,
    sourceLabel: version ? `git ref ${resolvedRef}` : `git branch ${resolvedRef}`,
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
  if [ "$MODE" = update ]; then
    node "$INSTALLER_ENTRY" --release-file "$RELEASE_FILE" --update
    return $?
  fi

  node "$INSTALLER_ENTRY" --release-file "$RELEASE_FILE"
}

launch_published_installer() {
  package_spec=${PACKAGE_NAME}@${VERSION}
  if [ "$MODE" = update ]; then
    npm exec --yes --package "$package_spec" -- rin-install --release-file "$RELEASE_FILE" --update
    return $?
  fi

  npm exec --yes --package "$package_spec" -- rin-install --release-file "$RELEASE_FILE"
}

INSTALLER_ENTRY='dist/app/rin-install/main.js'
PACKAGE_NAME='@hoshinorin/rin'
parse_args "$@"
check_node_version
: >"$LOGFILE"
run_step "$MANIFEST_LABEL" fetch_manifest
eval "$(resolve_release)"
PACKAGE_NAME=${PACKAGE_NAME:-@hoshinorin/rin}
RELEASE_FILE="$WORKDIR/release.json"
node - "$RELEASE_FILE" "$CHANNEL" "$VERSION" "$BRANCH" "$REF" "$SOURCE_LABEL" "$ARCHIVE_URL" <<'NODE'
const fs = require('node:fs');
const [file, channel, version, branch, ref, sourceLabel, archiveUrl] = process.argv.slice(2);
fs.writeFileSync(file, `${JSON.stringify({ channel, version, branch, ref, sourceLabel, archiveUrl })}\n`, { mode: 0o600 });
NODE

if [ "$CHANNEL" = stable ]; then
  if command -v npm >/dev/null 2>&1; then
    if has_tty; then
      say "$LAUNCH_LABEL"
      launch_published_installer </dev/tty >/dev/tty 2>&1
      exit $?
    fi
    run_step "$LAUNCH_LABEL" launch_published_installer
    exit 0
  fi
  echo "$NPM_ERROR" >&2
  exit 1
fi

run_step "$FETCH_LABEL" fetch "$ARCHIVE_URL" "$ARCHIVE"
mkdir -p "$SRC_DIR"
run_step "$PREP_LABEL" tar -xzf "$ARCHIVE" -C "$SRC_DIR" --strip-components=1

cd "$SRC_DIR"
if command -v npm >/dev/null 2>&1; then
  if [ -f package-lock.json ]; then
    run_step "Installing dependencies" npm ci --no-fund --no-audit
  else
    run_step "Installing dependencies" npm install --no-fund --no-audit
  fi
else
  echo "$NPM_ERROR" >&2
  exit 1
fi

run_step "$BUILD_LABEL" npm run build
say "$LAUNCH_LABEL"

if has_tty; then
  launch_installer_entry </dev/tty >/dev/tty 2>&1
  exit $?
fi

launch_installer_entry
