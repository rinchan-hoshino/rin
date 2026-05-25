#!/usr/bin/env bash
set -euo pipefail

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

mkdir -p "$workdir/repo"
tar -xf - -C "$workdir/repo"
cd "$workdir/repo"
ln -s /opt/rin/node_modules node_modules
export PATH="/opt/rin/node_modules/.bin:$PATH"
export RIN_INSTALL_TUI_CONTAINER_INNER=1

if [[ "${FORMAT_TARGETS_SET:-}" == "1" ]]; then
  mapfile -t format_targets < <(printf '%s\n' "${FORMAT_TARGETS:-}" | sed '/^$/d')
  if ((${#format_targets[@]} > 0)); then
    npm run format:check -- "${format_targets[@]}"
  else
    echo "No staged files need format checking."
  fi
else
  npm run format:check
fi

npm run lint

ci_timeout="45m"
echo "Running npm test with ${ci_timeout} timeout..."
timeout --foreground "$ci_timeout" npm test
