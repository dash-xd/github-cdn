#!/usr/bin/env bash
set -euo pipefail

root="${1:-$(pwd)}"

for dir in javascript golang; do
  if [[ ! -d "$root/$dir/.git" && ! -f "$root/$dir/.git" ]]; then
    echo "missing synced project: $root/$dir" >&2
    exit 1
  fi
done

js_expected="bd1038934d87338fcb9b3521c659bee8c1b60201"
go_expected="80f4f3e85cd920cac17bd3caeceba2d709a4ece3"

test "$(git -C "$root/javascript" rev-parse HEAD)" = "$js_expected"
test "$(git -C "$root/golang" rev-parse HEAD)" = "$go_expected"

(
  cd "$root/javascript"
  npm install --no-audit --no-fund
  npm test
)

(
  cd "$root/golang"
  go mod tidy
  go test ./...
)

echo "github-cdn manifest smoke passed"
