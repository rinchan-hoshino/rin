#!/bin/sh
set -eu

RIN_NODE_VERSION=24.18.0
RIN_NODE_BASE="https://nodejs.org/download/release/v${RIN_NODE_VERSION}"
RIN_INSTALL_HOME=${RIN_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/rin}
RIN_BOOTSTRAP_DIR=
RIN_NODE_STAGE=

cleanup() {
  [ -z "$RIN_BOOTSTRAP_DIR" ] || rm -rf -- "$RIN_BOOTSTRAP_DIR"
  [ -z "$RIN_NODE_STAGE" ] || rm -rf -- "$RIN_NODE_STAGE"
}
trap cleanup EXIT HUP INT TERM

node_is_usable() {
  command -v node >/dev/null 2>&1 || return 1
  node_path=$(node -p 'process.execPath' 2>/dev/null) || return 1
  case $node_path in "$HOME/.rin/"*) return 1 ;; esac
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' >/dev/null 2>&1
}

need_git=false
need_node=false
need_tools=false
command -v git >/dev/null 2>&1 && git --version >/dev/null 2>&1 || need_git=true
node_is_usable || need_node=true
command -v curl >/dev/null 2>&1 || need_tools=true
command -v tar >/dev/null 2>&1 || need_tools=true

if $need_git || $need_node || $need_tools; then
  printf '%s\n' 'Rin needs to install missing prerequisites before continuing:' >&2
  $need_git && printf '%s\n' '  - Git, using the operating system package manager' >&2
  $need_node && printf '  - Node.js v%s, downloaded from nodejs.org into %s/runtime\n' "$RIN_NODE_VERSION" "$RIN_INSTALL_HOME" >&2
  $need_tools && printf '%s\n' '  - download and archive tools required to verify Node.js' >&2
  if [ ! -r /dev/tty ]; then
    printf '%s\n' 'A terminal is required to approve prerequisite installation. Run this installer from a terminal.' >&2
    exit 1
  fi
  printf '%s' 'Continue? [y/N] ' >/dev/tty
  IFS= read -r answer </dev/tty || answer=
  case $answer in y|Y|yes|YES|Yes) ;; *) printf '%s\n' 'Installation cancelled.' >&2; exit 1 ;; esac
fi

run_as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else
    command -v sudo >/dev/null 2>&1 || { printf '%s\n' 'sudo is required to install system prerequisites.' >&2; exit 1; }
    sudo "$@"
  fi
}

install_linux_tools() {
  if command -v apt-get >/dev/null 2>&1; then
    run_as_root apt-get update
    run_as_root apt-get install -y git curl ca-certificates tar gzip xz-utils
  elif command -v dnf >/dev/null 2>&1; then
    run_as_root dnf install -y git curl ca-certificates tar gzip xz
  elif command -v pacman >/dev/null 2>&1; then
    run_as_root pacman -S --needed --noconfirm git curl ca-certificates tar gzip xz || {
      printf '%s\n' 'Package installation failed. Complete a full system upgrade with pacman -Syu, then retry Rin installation.' >&2
      exit 1
    }
  else
    printf '%s\n' 'No supported package manager was found. Install Git, curl, tar, and CA certificates, then retry.' >&2
    exit 1
  fi
}

if $need_git || $need_tools; then
  case $(uname -s) in
    Darwin)
      if $need_tools; then printf '%s\n' 'macOS should provide curl and tar. Install the Command Line Tools, then retry.' >&2; exit 1; fi
      if command -v brew >/dev/null 2>&1; then
        brew install git
      else
        printf '%s\n' 'Opening the macOS Command Line Tools installer for Git. Complete the dialog to continue.' >&2
        xcode-select --install 2>/dev/null || true
        attempts=0
        while [ "$attempts" -lt 60 ]; do
          if command -v git >/dev/null 2>&1 && git --version >/dev/null 2>&1; then break; fi
          sleep 5
          attempts=$((attempts + 1))
        done
        if ! command -v git >/dev/null 2>&1 || ! git --version >/dev/null 2>&1; then
          printf '%s\n' 'Command Line Tools did not finish within five minutes. Complete it, then run this installer again.' >&2
          exit 1
        fi
      fi
      ;;
    Linux) install_linux_tools ;;
    *) printf '%s\n' 'This installer supports macOS and Linux. Use install.ps1 on Windows.' >&2; exit 1 ;;
  esac
  hash -r
fi

install_managed_node() {
  system=$(uname -s)
  machine=$(uname -m)
  case $machine in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) printf 'Unsupported architecture for Node.js: %s\n' "$machine" >&2; exit 1 ;; esac
  case $system in Darwin) platform=darwin ;; Linux) platform=linux ;; *) printf 'Unsupported operating system for Node.js: %s\n' "$system" >&2; exit 1 ;; esac
  archive="node-v${RIN_NODE_VERSION}-${platform}-${arch}.tar.gz"
  runtime="$RIN_INSTALL_HOME/runtime"
  target="$runtime/node-v${RIN_NODE_VERSION}"
  mkdir -p -- "$runtime"
  if [ -e "$target" ] && [ ! -x "$target/bin/node" ]; then printf 'An incomplete Node.js directory exists: %s\n' "$target" >&2; exit 1; fi
  if [ ! -x "$target/bin/node" ]; then
    RIN_NODE_STAGE=$(mktemp -d "$runtime/.node-install.XXXXXX")
    curl --proto '=https' --tlsv1.2 -fL "$RIN_NODE_BASE/$archive" -o "$RIN_NODE_STAGE/$archive"
    curl --proto '=https' --tlsv1.2 -fL "$RIN_NODE_BASE/SHASUMS256.txt" -o "$RIN_NODE_STAGE/SHASUMS256.txt"
    checksum=$(awk -v file="$archive" '$2 == file { print $1; found++ } END { if (found != 1) exit 1 }' "$RIN_NODE_STAGE/SHASUMS256.txt") || { printf '%s\n' 'Node.js checksum entry is missing or ambiguous.' >&2; exit 1; }
    if command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$RIN_NODE_STAGE/$archive" | awk '{print $1}')
    elif command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$RIN_NODE_STAGE/$archive" | awk '{print $1}')
    else printf '%s\n' 'No SHA-256 verification tool is available.' >&2; exit 1; fi
    [ "$actual" = "$checksum" ] || { printf '%s\n' 'Node.js archive checksum verification failed.' >&2; exit 1; }
    tar -xzf "$RIN_NODE_STAGE/$archive" -C "$RIN_NODE_STAGE"
    extracted="$RIN_NODE_STAGE/node-v${RIN_NODE_VERSION}-${platform}-${arch}"
    [ -x "$extracted/bin/node" ] || { printf '%s\n' 'Verified Node.js archive has an unexpected layout.' >&2; exit 1; }
    mv -- "$extracted" "$target"
  fi
  PATH="$target/bin:$PATH"
  export PATH
  hash -r
}

node_is_usable || install_managed_node
node_is_usable || { printf '%s\n' 'Node.js 24 could not be prepared.' >&2; exit 1; }
command -v git >/dev/null 2>&1 || { printf '%s\n' 'Git installation did not complete. Run this installer again.' >&2; exit 1; }

RIN_SCRIPT_DIR=
case $0 in */install.sh|install.sh) RIN_SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd) ;; esac
if [ -n "$RIN_SCRIPT_DIR" ] && [ -f "$RIN_SCRIPT_DIR/src/install/bootstrap.mjs" ]; then
  node "$RIN_SCRIPT_DIR/src/install/bootstrap.mjs" </dev/tty
  exit $?
fi

RIN_BOOTSTRAP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/rin-install.XXXXXX")
git clone --depth 1 --branch main https://github.com/rinchan-hoshino/rin.git "$RIN_BOOTSTRAP_DIR/source"
node "$RIN_BOOTSTRAP_DIR/source/src/install/bootstrap.mjs" </dev/tty
