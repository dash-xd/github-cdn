#!/usr/bin/env bash
set -euo pipefail

implementation="${1:-javascript}"
workspace="${2:-.composition}"
manifest_url="${GITHUB_CDN_MANIFEST_URL:-https://github.com/dash-xd/github-cdn.git}"
manifest_revision="${GITHUB_CDN_MANIFEST_REVISION:-main}"

case "$implementation" in
  javascript)
    runtime=nodejs24
    entry_point=Main
    ;;
  golang)
    runtime=go126
    entry_point=Main
    ;;
  *)
    echo "usage: $0 [javascript|golang] [workspace]" >&2
    exit 2
    ;;
esac

mkdir -p "$workspace"
workspace="$(cd "$workspace" && pwd)"

(
  cd "$workspace"
  repo init -u "$manifest_url" -b "$manifest_revision" -m default.xml
  repo sync -c --no-tags "$implementation"
)

cat >"$workspace/deployment.json" <<EOF
{
  "implementation": "$implementation",
  "source_dir": "$workspace/$implementation",
  "runtime": "$runtime",
  "entry_point": "$entry_point",
  "manifest_url": "$manifest_url",
  "manifest_revision": "$manifest_revision"
}
EOF

printf 'composed %s at %s\n' "$implementation" "$workspace/$implementation"
printf 'terraform: -var=source_dir=%q -var=runtime=%q -var=entry_point=%q\n' "$workspace/$implementation" "$runtime" "$entry_point"
