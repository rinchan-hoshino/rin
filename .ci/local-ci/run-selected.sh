#!/usr/bin/env bash
set -euo pipefail

cd /opt/rin/source
export PATH="/opt/rin/node_modules/.bin:$PATH"
export RIN_INSTALL_TUI_CONTAINER_INNER=1
export RIN_SYSTEM_TEST_CONTAINER_INNER=1

npm run build

if [[ "${1:-}" == "--unit-owner-coverage" ]]; then
  if [[ $# -ne 2 ]]; then
    echo "usage: npm run test:container -- --unit-owner-coverage <test-file>" >&2
    exit 2
  fi
  exec tsx scripts/test/run-coverage.ts --unit --owner-test "$2"
fi

if [[ "${1:-}" == "--non-unit-owner-coverage" ]]; then
  shift
  if [[ $# -eq 0 ]]; then
    echo "usage: npm run test:container -- --non-unit-owner-coverage <source-file> [...]" >&2
    exit 2
  fi
  coverage_status=0
  for source_file in "$@"; do
    tsx scripts/test/run-coverage.ts --non-unit --source "$source_file" || coverage_status=$?
  done
  exit "$coverage_status"
fi

if [[ "${1:-}" == "--combined-coverage" ]]; then
  if [[ $# -ne 1 ]]; then
    echo "usage: npm run test:container -- --combined-coverage" >&2
    exit 2
  fi
  exec tsx scripts/test/run-coverage.ts --combined
fi

if [[ "${1:-}" == "--suite" ]]; then
  if [[ $# -ne 2 ]]; then
    echo "usage: npm run test:container -- --suite <suite>" >&2
    exit 2
  fi
  case "$2" in
    types|release|architecture|unit|unit:coverage|acceptance|property|mutation|qa|torture|regression|characterization|integration|system|coverage)
      exec npm run "test:$2:run"
      ;;
    *)
      echo "unknown containerized test suite: $2" >&2
      exit 2
      ;;
  esac
fi

if [[ "${1:-}" == "--manual-install-tui" ]]; then
  shift
  exec node --import tsx tests/system/install-to-tui-manual.ts "$@"
fi

if [[ $# -eq 0 ]]; then
  echo "usage: npm run test:container -- <test-file> [...]" >&2
  exit 2
fi

exec node --import tsx scripts/test/run-test-files.ts --concurrency=1 "$@"
