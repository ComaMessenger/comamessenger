#!/usr/bin/env bash
# Starts the s3gw Compose profile under the given project name and checks
# with real CORS preflights that the app origin may PUT (and sees ETag) while
# another origin is refused. Used by CI; the caller stops the project.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
project="${1:?usage: check-s3gw-cors.sh <compose-project>}"
port="${S3_GATEWAY_PORT:-9100}"
env_file="$(mktemp)"
trap 'rm -f "$env_file"' EXIT
cat > "$env_file" <<ENV
S3_GATEWAY_ACCESS_KEY=ci$(openssl rand -hex 6)
S3_GATEWAY_SECRET_KEY=$(openssl rand -hex 24)
S3_GATEWAY_PORT=$port
S3_BUCKET=coma-cors-check
PUBLIC_APP_URL=https://app.example.test
ENV
compose=(docker compose -p "$project" --env-file "$env_file" -f deploy/compose.yaml --profile s3gw)
"${compose[@]}" up -d --wait s3gw
"${compose[@]}" up s3gw-init

preflight() {
  curl -s -o /dev/null -D - -X OPTIONS "http://127.0.0.1:$port/coma-cors-check/objects/00/00/check" \
    -H "Origin: $1" -H "Access-Control-Request-Method: PUT" -H "Access-Control-Request-Headers: content-type" | tr -d '\r'
}
allowed="$(preflight https://app.example.test)"
refused="$(preflight https://other.example.test)"
echo "$allowed" | grep -q '^HTTP/1.1 200' || { echo "app origin preflight was not allowed:"; echo "$allowed"; exit 1; } >&2
echo "$allowed" | grep -qi '^access-control-allow-origin: https://app.example.test$' || { echo "missing Allow-Origin" >&2; exit 1; }
echo "$allowed" | grep -qi '^access-control-expose-headers:.*etag' || { echo "ETag is not exposed" >&2; exit 1; }
echo "$refused" | grep -q '^HTTP/1.1 403' || { echo "another origin was not refused:"; echo "$refused"; exit 1; } >&2
echo "s3gw CORS: app origin allowed with ETag exposed, other origins refused"
