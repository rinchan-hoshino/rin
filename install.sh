#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
BOOTSTRAP_MODE=${RIN_BOOTSTRAP_WRAPPER_MODE:-install}
LOCAL_BOOTSTRAP_SCRIPT="$SCRIPT_DIR/scripts/bootstrap-entrypoint.sh"
if [ -f "$LOCAL_BOOTSTRAP_SCRIPT" ]; then
  exec sh "$LOCAL_BOOTSTRAP_SCRIPT" "$BOOTSTRAP_MODE" "$@"
fi

REPO_URL=${RIN_INSTALL_REPO_URL:-https://github.com/rinchanai/rin}
DEFAULT_BOOTSTRAP_BRANCH=bootstrap
BOOTSTRAP_BRANCH=${RIN_BOOTSTRAP_BRANCH:-$DEFAULT_BOOTSTRAP_BRANCH}
RAW_BASE=$(printf '%s' "$REPO_URL" | sed -e 's#^https://github.com/#https://raw.githubusercontent.com/#' -e 's#\.git$##')
BOOTSTRAP_SCRIPT_URL=${RIN_BOOTSTRAP_SCRIPT_URL:-$RAW_BASE/$BOOTSTRAP_BRANCH/scripts/bootstrap-entrypoint.sh}
MAIN_BOOTSTRAP_SCRIPT_URL=${RIN_BOOTSTRAP_SCRIPT_FALLBACK_URL:-$RAW_BASE/main/scripts/bootstrap-entrypoint.sh}
CACHE_BASE=${XDG_CACHE_HOME:-${HOME:-/tmp}/.cache}
TMPDIR_BASE=${RIN_INSTALL_TMPDIR:-$CACHE_BASE/rin-install}
mkdir -p "$TMPDIR_BASE"
BOOTSTRAP_SCRIPT=$(mktemp "$TMPDIR_BASE/bootstrap-entrypoint.XXXXXX.sh")
cleanup() {
  rm -f "$BOOTSTRAP_SCRIPT"
}
trap cleanup EXIT INT TERM

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
  echo "rin bootstrap wrapper requires curl or wget" >&2
  exit 1
}

has_tty() {
  [ -t 1 ] && [ -t 2 ]
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
      printf '\r%s %s' "$frame" "$label"
    fi
    i=$(( (i + 1) % 10 ))
    sleep 0.1
  done
}

run_step() {
  label=$1
  shift
  "$@" &
  pid=$!
  render_spinner "$label" "$pid"
  set +e
  wait "$pid"
  status=$?
  set -e
  if has_tty; then
    if [ "$status" -eq 0 ]; then
      printf '\r✓ %s\033[K\n' "$label"
    else
      printf '\r✗ %s\033[K\n' "$label"
    fi
  fi
  return "$status"
}

fetch_bootstrap_script() {
  if fetch "$BOOTSTRAP_SCRIPT_URL" "$BOOTSTRAP_SCRIPT"; then
    return 0
  fi
  if [ -n "$MAIN_BOOTSTRAP_SCRIPT_URL" ] && [ "$MAIN_BOOTSTRAP_SCRIPT_URL" != "$BOOTSTRAP_SCRIPT_URL" ]; then
    # Older bootstrap exports may only carry install.sh/update.sh, so fall back to main's shared entrypoint.
    fetch "$MAIN_BOOTSTRAP_SCRIPT_URL" "$BOOTSTRAP_SCRIPT"
    return 0
  fi
  return 1
}

run_step "Fetching Rin bootstrap" fetch_bootstrap_script
sh "$BOOTSTRAP_SCRIPT" "$BOOTSTRAP_MODE" "$@"
