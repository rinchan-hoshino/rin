#!/usr/bin/env bash
set -euo pipefail

cd /opt/rin/source
export PATH="/opt/rin/node_modules/.bin:$PATH"
export RIN_INSTALL_TUI_CONTAINER_INNER=1
export RIN_SYSTEM_TEST_CONTAINER_INNER=1

if [[ -n "${FORMAT_TARGETS:-}" ]]; then
  read -r -a format_targets <<<"$FORMAT_TARGETS"
  tsx scripts/run-format-check.ts --check "${format_targets[@]}"
else
  echo "No staged files need format checking."
fi
npm run lint
npm run build

mapfile -t plan < <(
  printf '%s' "${STAGED_FILES:-}" | tsx scripts/test/staged-test-plan-cli.ts
)

if [[ "${plan[0]:-}" == "full" ]]; then
  exec .ci/local-ci/run-checks.sh
fi

if [[ "${plan[4]:-}" == "architecture" ]]; then
  npm run test:architecture:run
fi

if [[ -n "${plan[1]:-}" ]]; then
  read -r -a owner_tests <<<"${plan[1]}"
  for owner_test in "${owner_tests[@]}"; do
    tsx scripts/test/run-coverage.ts --unit --owner-test "$owner_test"
  done
fi

if [[ -n "${plan[2]:-}" ]]; then
  read -r -a sources <<<"${plan[2]}"
  for source_file in "${sources[@]}"; do
    tsx scripts/test/run-coverage.ts --non-unit --source "$source_file"
  done
fi

if [[ -n "${plan[3]:-}" ]]; then
  read -r -a direct_tests <<<"${plan[3]}"
  node --import tsx scripts/test/run-test-files.ts --concurrency=1 "${direct_tests[@]}"
fi
