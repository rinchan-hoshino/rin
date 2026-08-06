#!/usr/bin/env bash
set -euo pipefail

archive_file="${1:?usage: build-test-image.sh ARCHIVE IMAGE_TAG}"
image_tag="${2:?usage: build-test-image.sh ARCHIVE IMAGE_TAG}"
docker_cmd="${DOCKER_CMD:-docker}"
dockerfile=".ci/local-ci/Dockerfile"

if "$docker_cmd" image inspect "$image_tag" >/dev/null 2>&1; then
  echo "rin tests: reusing source image $image_tag."
  exit 0
fi

dependency_fingerprint="$({
  for relative_path in \
    .ci/local-ci/Dockerfile \
    package.json \
    package-lock.json \
    scripts/install-git-hooks.ts
  do
    printf '%s\0' "$relative_path"
    tar -xOf "$archive_file" "$relative_path"
  done
} | sha256sum | cut -d' ' -f1)"
dependency_tag="rin-local-ci:deps-${dependency_fingerprint:0:20}"

if ! "$docker_cmd" image inspect "$dependency_tag" >/dev/null 2>&1; then
  echo "rin tests: building dependency image $dependency_tag..."
  "$docker_cmd" build \
    --target dependencies \
    -f "$dockerfile" \
    -t "$dependency_tag" \
    - <"$archive_file"
else
  echo "rin tests: reusing dependency image $dependency_tag."
fi

"$docker_cmd" build \
  --cache-from "$dependency_tag" \
  -f "$dockerfile" \
  -t "$image_tag" \
  - <"$archive_file"
