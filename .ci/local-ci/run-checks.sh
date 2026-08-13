#!/usr/bin/env bash
set -euo pipefail

cd /opt/rin/source
export PATH="/opt/rin/node_modules/.bin:$PATH"
export RIN_INSTALL_TUI_CONTAINER_INNER=1
export RIN_SYSTEM_TEST_CONTAINER_INNER=1

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
npm run build
npm run test:types:run

ci_timeout="45m"
echo "Running the complete test gate with ${ci_timeout} timeout..."
timeout --foreground "$ci_timeout" bash -c '
  # The ordinary gate runs every current behavior suite once in an isolated
  # sandbox. Coverage and mutation remain explicit calibration commands.
  npm run test:inner
'
