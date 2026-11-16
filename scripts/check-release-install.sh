#!/usr/bin/env bash
# Installs Coma from a release bundle the way docs/install.md describes, with
# no source tree around, and checks it end to end:
#   generate-env → up → first owner (bootstrap token) → invitation → message
#   with a file → backup → restore into a second, empty installation → the
#   message and the file are there, the owner signs in.
# Uses its own Compose project names and removes only their containers and
# volumes.
#
#   ./scripts/check-release-install.sh dist/coma-deploy-0.1.0.tar.gz
# For images built locally: bundle with COMA_BUNDLE_UNPINNED=1 (release-bundle.sh).
set -euo pipefail

bundle=$(cd "$(dirname "${1:?usage: $0 <coma-deploy-*.tar.gz>}")" && pwd)/$(basename "$1")
port=${COMA_CHECK_PORT:-18088}
project=${COMA_CHECK_PROJECT:-coma-release-check}
work=$(mktemp -d "${TMPDIR:-/tmp}/coma-release-check.XXXXXX")
api="http://localhost:$port"

say() { printf '\n▶ %s\n' "$*"; }
fail() {
  printf '✘ %s\n' "$*" >&2
  exit 1
}
uuid() { openssl rand -hex 16 | sed -E 's/(.{8})(.{4})(.{4})(.{4})(.{12})/\1-\2-\3-\4-\5/'; }

cleanup() {
  status=$?
  for dir in "$work/first" "$work/restored"; do
    [ -f "$dir/compose.yaml" ] || continue
    name=$project-$(basename "$dir")
    if [ $status -ne 0 ]; then
      (cd "$dir" && COMPOSE_PROJECT_NAME=$name docker compose logs --tail 60 core caddy 2>/dev/null) || true
    fi
    (cd "$dir" && COMPOSE_PROJECT_NAME=$name docker compose down -v --remove-orphans >/dev/null 2>&1) || true
  done
  rm -rf "$work"
  exit $status
}
trap cleanup EXIT

install() { # <directory>
  mkdir -p "$1"
  tar -xzf "$bundle" -C "$1" --strip-components 1
}

json() { # <method> <path> <token or -> [body] → body; HTTP status in $code
  local method=$1 path=$2 token=$3 body=${4:-}
  local args=(--silent --show-error --output "$work/response.json" --write-out '%{http_code}' --request "$method")
  [ "$token" != - ] && args+=(--header "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(--header 'Content-Type: application/json' --data "$body")
  code=$(curl "${args[@]}" "$api$path")
  cat "$work/response.json"
}

say "first installation from $(basename "$bundle")"
install "$work/first"
cd "$work/first"
export COMPOSE_PROJECT_NAME=$project-first
./generate-env.sh "localhost:$port"
docker compose up -d --wait --wait-timeout 300
curl -fsS "$api/healthz" >/dev/null || fail "healthz"
curl -fsS "$api/" | grep -q '<div id="root">' || fail "web page"
curl -fsS "$api/config.js" | grep -q '__COMA_CONFIG__' || fail "config.js"
# Only Caddy may publish ports on the host.
published=$(docker ps --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --format '{{.Names}} {{.Ports}}' |
  grep -- '->' | grep -v -- '-caddy-' || true)
[ -z "$published" ] || fail "services other than Caddy publish ports: $published"

say "first owner"
bootstrap_token=$(sed -n 's/^BOOTSTRAP_TOKEN=//p' .env)
owner='{"organization_name":"Release Check","organization_slug":"release-check","display_name":"Owner","handle":"owner","email":"owner@example.test","password":"correct horse battery staple","timezone":"UTC"}'
curl --silent --output /dev/null --write-out '%{http_code}' --request POST --header 'Content-Type: application/json' \
  --data "$owner" "$api/api/v1/bootstrap" | grep -qE '^40[13]$' || fail "bootstrap without the token was accepted"
code=$(curl --silent --show-error --output "$work/owner.json" --write-out '%{http_code}' --request POST \
  --header 'Content-Type: application/json' --header "X-Coma-Bootstrap-Token: $bootstrap_token" \
  --data "$owner" "$api/api/v1/bootstrap")
[ "$code" = 201 ] || fail "bootstrap returned $code: $(cat "$work/owner.json")"
owner_token=$(jq -r .access_token "$work/owner.json")

say "invitation"
invite=$(json POST /api/v1/invitations "$owner_token" '{"email":"member@example.test","role":"member"}')
[ "$code" = 201 ] || [ "$code" = 200 ] || fail "invitation returned $code: $invite"
invite_token=$(printf '%s' "$invite" | jq -r '.accept_url | split("/") | last')
member=$(json POST "/api/v1/invitations/$invite_token/accept" - '{"display_name":"Member","handle":"member","password":"member secure password","timezone":"UTC"}')
[ "$code" = 201 ] || [ "$code" = 200 ] || fail "accepting the invitation returned $code: $member"
member_id=$(printf '%s' "$member" | jq -r .user.id)

say "message with a file"
chat=$(json POST /api/v1/chats "$owner_token" "{\"kind\":\"group\",\"visibility\":\"private\",\"name\":\"Release check\",\"member_ids\":[\"$member_id\"]}")
chat_id=$(printf '%s' "$chat" | jq -r .id)
printf 'Coma release check %s\n' "$(date -u)" > "$work/note.txt"
size=$(wc -c < "$work/note.txt" | tr -d ' ')
upload=$(json POST /api/v1/files/uploads "$owner_token" "{\"name\":\"note.txt\",\"mime\":\"text/plain\",\"size\":$size}")
[ "$code" = 201 ] || fail "upload reservation returned $code: $upload"
upload_id=$(printf '%s' "$upload" | jq -r .id)
[ "$(printf '%s' "$upload" | jq -r .mode)" = streaming ] || fail "local storage should stream uploads"
code=$(curl --silent --show-error --output "$work/file.json" --write-out '%{http_code}' --request PUT \
  --header "Authorization: Bearer $owner_token" --header 'Content-Type: application/octet-stream' \
  --data-binary "@$work/note.txt" "$api/api/v1/files/uploads/$upload_id/content")
[ "$code" = 200 ] || fail "upload returned $code: $(cat "$work/file.json")"
file_id=$(jq -r .id "$work/file.json")
message=$(json POST "/api/v1/chats/$chat_id/messages" "$owner_token" "{\"client_msg_id\":\"$(uuid)\",\"body\":\"Before the backup\",\"file_ids\":[\"$file_id\"]}")
[ "$code" = 201 ] || [ "$code" = 200 ] || fail "message returned $code: $message"
curl -fsS -L --header "Authorization: Bearer $owner_token" "$api/api/v1/files/$file_id/download" -o "$work/downloaded.txt"
cmp -s "$work/note.txt" "$work/downloaded.txt" || fail "downloaded file differs"

say "backup"
./backup.sh
archive=$(ls -1 backups/coma-*.tar | tail -n 1)
[ -n "$archive" ] || fail "no archive"
json POST "/api/v1/chats/$chat_id/messages" "$owner_token" "{\"client_msg_id\":\"$(uuid)\",\"body\":\"After the backup\"}" >/dev/null
cp "$archive" "$work/backup.tar"
docker compose down

say "restore into an empty installation"
install "$work/restored"
cd "$work/restored"
export COMPOSE_PROJECT_NAME=$project-restored
./restore.sh --yes "$work/backup.tar"
login=$(json POST /api/v1/auth/login - '{"email":"owner@example.test","password":"correct horse battery staple"}')
[ "$code" = 200 ] || [ "$code" = 201 ] || fail "owner login after restore returned $code: $login"
restored_token=$(printf '%s' "$login" | jq -r .access_token)
messages=$(json GET "/api/v1/chats/$chat_id/messages" "$restored_token")
printf '%s' "$messages" | jq -e '[.messages[].body] | index("Before the backup") != null' >/dev/null || fail "message from before the backup is missing"
printf '%s' "$messages" | jq -e '[.messages[].body] | index("After the backup") == null' >/dev/null || fail "message from after the backup appeared"
curl -fsS -L --header "Authorization: Bearer $restored_token" "$api/api/v1/files/$file_id/download" -o "$work/restored.txt"
cmp -s "$work/note.txt" "$work/restored.txt" || fail "restored file differs"
status=$(json GET /api/v1/bootstrap/status -)
[ "$(printf '%s' "$status" | jq -r .bootstrapped)" = true ] || fail "restored installation is not bootstrapped"

say "release installation works: first owner, invitation, message, file, backup and restore"
