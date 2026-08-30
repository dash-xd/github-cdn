#!/usr/bin/env bash
set -euo pipefail

project="${PROJECT_ID:?set PROJECT_ID}"
region="${REGION:?set REGION}"
service="${SERVICE_NAME:?set SERVICE_NAME}"
github_token="${GH_DEVICE_ACCESS_TOKEN:?set GH_DEVICE_ACCESS_TOKEN}"
port="${PORT:-8085}"

cleanup() {
  if [[ -n "${proxy_pid:-}" ]]; then
    kill "$proxy_pid" 2>/dev/null || true
    wait "$proxy_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

function_uri="$(gcloud run services describe "$service" \
  --project="$project" \
  --region="$region" \
  --format='value(status.url)')"

if [[ -z "$function_uri" ]]; then
  echo "failed to resolve Cloud Run service URL" >&2
  exit 1
fi

unauth_code="$(curl -sS -o /dev/null -w '%{http_code}' "$function_uri/github/repos/octocat/Hello-World/main" || true)"
case "$unauth_code" in
  401|403) ;;
  *)
    echo "expected Google IAM to reject an unauthenticated direct request, got HTTP $unauth_code" >&2
    exit 1
    ;;
esac

gcloud run services proxy "$service" \
  --project="$project" \
  --region="$region" \
  --port="$port" \
  >/tmp/github-cdn-cloud-run-proxy.log 2>&1 &
proxy_pid=$!

for _ in {1..30}; do
  if curl -fsS "http://127.0.0.1:$port/" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$proxy_pid" 2>/dev/null; then
    cat /tmp/github-cdn-cloud-run-proxy.log >&2
    exit 1
  fi
  sleep 1
done

curl -fsS \
  -H "X-GH-Device-Access-Token: $github_token" \
  "http://127.0.0.1:$port/github/repos/octocat/Hello-World/main" \
  >/dev/null

echo "private Cloud Run IAM + GitHub token smoke test passed"
