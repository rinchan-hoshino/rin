#!/bin/sh
set -eu

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Rin needs Node.js 24 or newer with npm. Install the official Node.js 24+ package, then run this installer again.' >&2
  exit 1
fi
node -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' || {
  printf '%s\n' 'Rin needs Node.js 24 or newer with npm. Upgrade Node.js, then run this installer again.' >&2
  exit 1
}
command -v git >/dev/null 2>&1 || { printf '%s\n' 'Rin needs Git. Install Git from your operating system package manager, then run this installer again.' >&2; exit 1; }

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node "$root/src/install/bootstrap.mjs"
