#!/bin/sh
set -eu

api_url="${API_URL:-http://localhost:8080}"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

status="$(curl --silent --show-error "$api_url/api/v1/bootstrap/status")"
test "$(printf '%s' "$status" | jq -r .bootstrapped)" = "false"

bootstrap_code="$(curl --silent --show-error --cookie-jar "$work_dir/owner.cookies" \
  --output "$work_dir/owner.json" --write-out '%{http_code}' --request POST \
  --header 'Content-Type: application/json' \
  --data '{"organization_name":"Smoke Organization","organization_slug":"smoke","display_name":"Owner","handle":"owner","email":"owner@example.test","password":"correct horse battery staple","timezone":"UTC"}' \
  "$api_url/api/v1/bootstrap")"
test "$bootstrap_code" = "201"
owner_token="$(jq -r .access_token "$work_dir/owner.json")"

repeat_code="$(curl --silent --show-error --output "$work_dir/repeat.json" --write-out '%{http_code}' \
  --request POST --header 'Content-Type: application/json' \
  --data '{"organization_name":"Second","organization_slug":"second","display_name":"Other","handle":"other","email":"other@example.test","password":"another secure password"}' \
  "$api_url/api/v1/bootstrap")"
test "$repeat_code" = "409"

curl --fail --silent --show-error --output "$work_dir/invite.json" --request POST \
  --header 'Content-Type: application/json' --header "Authorization: Bearer $owner_token" \
  --data '{"email":"member@example.test","role":"member"}' "$api_url/api/v1/invitations"
invite_token="$(jq -r '.accept_url | split("/") | last' "$work_dir/invite.json")"

curl --fail --silent --show-error --output "$work_dir/member.json" --request POST \
  --header 'Content-Type: application/json' \
  --data '{"display_name":"Member","handle":"member","password":"member secure password","timezone":"UTC"}' \
  "$api_url/api/v1/invitations/$invite_token/accept"
member_token="$(jq -r .access_token "$work_dir/member.json")"
member_id="$(jq -r .user.id "$work_dir/member.json")"
owner_id="$(jq -r .user.id "$work_dir/owner.json")"

curl --fail --silent --show-error --output "$work_dir/group.json" --request POST \
  --header 'Content-Type: application/json' --header "Authorization: Bearer $owner_token" \
  --data "{\"kind\":\"group\",\"visibility\":\"private\",\"name\":\"Team\",\"member_ids\":[\"$member_id\"]}" \
  "$api_url/api/v1/chats"

curl --fail --silent --show-error --output "$work_dir/direct-owner.json" --request POST \
  --header 'Content-Type: application/json' --header "Authorization: Bearer $owner_token" \
  --data "{\"kind\":\"direct\",\"visibility\":\"private\",\"member_ids\":[\"$member_id\"]}" \
  "$api_url/api/v1/chats"
curl --fail --silent --show-error --output "$work_dir/direct-member.json" --request POST \
  --header 'Content-Type: application/json' --header "Authorization: Bearer $member_token" \
  --data "{\"kind\":\"direct\",\"visibility\":\"private\",\"member_ids\":[\"$owner_id\"]}" \
  "$api_url/api/v1/chats"
test "$(jq -r .id "$work_dir/direct-owner.json")" = "$(jq -r .id "$work_dir/direct-member.json")"

curl --fail --silent --show-error --output "$work_dir/channel.json" --request POST \
  --header 'Content-Type: application/json' --header "Authorization: Bearer $owner_token" \
  --data '{"kind":"channel","visibility":"public","name":"Announcements"}' "$api_url/api/v1/chats"
member_channel_code="$(curl --silent --show-error --output "$work_dir/forbidden.json" --write-out '%{http_code}' \
  --request POST --header 'Content-Type: application/json' --header "Authorization: Bearer $member_token" \
  --data '{"kind":"channel","visibility":"public","name":"Forbidden"}' "$api_url/api/v1/chats")"
test "$member_channel_code" = "403"

echo "Phase 1 API smoke test passed."
