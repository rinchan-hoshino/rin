#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if ! command -v docker >/dev/null 2>&1; then
  echo "rin tests: docker is required for isolated test execution." >&2
  exit 1
fi

index_file="$(mktemp)"
archive_file="$(mktemp)"
rm -f "$index_file"
cleanup() {
  rm -f "$index_file" "$archive_file"
}
trap cleanup EXIT

GIT_INDEX_FILE="$index_file" git read-tree HEAD
GIT_INDEX_FILE="$index_file" git add -A
working_tree="$(GIT_INDEX_FILE="$index_file" git write-tree)"
GIT_INDEX_FILE="$index_file" git archive --format=tar \
  --mtime=1970-01-01T00:00:00Z \
  "$working_tree" >"$archive_file"
archive_fingerprint="$(sha256sum "$archive_file" | cut -d' ' -f1)"
image_tag="rin-local-ci:source-${archive_fingerprint:0:20}"

echo "rin tests: preparing isolated working-tree image..."
scripts/test/build-test-image.sh "$archive_file" "$image_tag"
image_id="$(docker image inspect --format '{{.Id}}' "$image_tag")"

docker_args=(run --rm --network none --memory 4g --memory-swap 4g)
if (($# > 0)); then
  echo "rin tests: running a selected test target in a networkless container..."
  docker_args+=(--entrypoint /opt/rin/source/.ci/local-ci/run-selected.sh)
else
  echo "rin tests: running the complete gate in a networkless container..."
fi
if [[ -t 0 && -t 1 ]]; then
  docker_args+=(-it)
else
  docker_args+=(-i)
fi
docker_args+=("$image_id")
if (($# > 0)); then
  docker_args+=("$@")
fi

docker "${docker_args[@]}"
