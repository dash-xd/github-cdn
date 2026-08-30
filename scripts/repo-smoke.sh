#!/usr/bin/env bash
set -euo pipefail

repo_bin="${REPO_BIN:-repo}"
manifest_url="${MANIFEST_URL:-https://github.com/dash-xd/github-cdn.git}"
manifest_branch="${MANIFEST_BRANCH:-main}"
manifest_name="${MANIFEST_NAME:-default.xml}"
workspace="${1:-${PWD}/.repo-smoke}"

command -v "$repo_bin" >/dev/null 2>&1 || {
  echo "Android repo launcher not found: $repo_bin" >&2
  exit 127
}

rm -rf "$workspace"
mkdir -p "$workspace"

(
  cd "$workspace"

  # default.xml is the composition contract. Keep GitHub Actions out of the
  # composition logic so this exact script can later be invoked from Nix.
  "$repo_bin" init \
    -u "$manifest_url" \
    -b "$manifest_branch" \
    -m "$manifest_name"
  "$repo_bin" sync -c --no-tags

  # Run the smoke script from the manifest checkout itself, so the tested
  # validation logic is the one associated with this exact manifest revision.
  .repo/manifests/scripts/smoke-local.sh "$PWD"
)

echo "github-cdn repo composition smoke passed"
