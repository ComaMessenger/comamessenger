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
group_id="$(jq -r .id "$work_dir/group.json")"

curl --fail --silent --show-error --output "$work_dir/group-updated.json" --request PATCH \
  --header 'Content-Type: application/json' --header "Authorization: Bearer $owner_token" \
  --data '{"name":"Product Team","topic":"Build the messenger"}' \
  "$api_url/api/v1/chats/$group_id"
test "$(jq -r .name "$work_dir/group-updated.json")" = "Product Team"

member_update_code="$(curl --silent --show-error --output "$work_dir/member-update-forbidden.json" --write-out '%{http_code}' \
  --request PATCH --header 'Content-Type: application/json' --header "Authorization: Bearer $member_token" \
  --data '{"name":"Nope"}' "$api_url/api/v1/chats/$group_id")"
test "$member_update_code" = "403"

curl --fail --silent --show-error --output "$work_dir/member-promoted.json" --request PATCH \
  --header 'Content-Type: application/json' --header "Authorization: Bearer $owner_token" \
  --data '{"role":"admin"}' "$api_url/api/v1/chats/$group_id/members/$member_id"
test "$(jq -r .role "$work_dir/member-promoted.json")" = "admin"

last_owner_code="$(curl --silent --show-error --output "$work_dir/last-owner.json" --write-out '%{http_code}' \
  --request DELETE --header "Authorization: Bearer $owner_token" \
  "$api_url/api/v1/chats/$group_id/members/$owner_id")"
test "$last_owner_code" = "409"

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
channel_id="$(jq -r .id "$work_dir/channel.json")"

curl --fail --silent --show-error --output "$work_dir/discover.json" \
  --header "Authorization: Bearer $member_token" "$api_url/api/v1/chats/discover"
test "$(jq --arg id "$channel_id" '[.chats[].id] | index($id) != null' "$work_dir/discover.json")" = "true"

curl --fail --silent --show-error --output "$work_dir/joined.json" --request POST \
  --header "Authorization: Bearer $member_token" "$api_url/api/v1/chats/$channel_id/join"
test "$(jq -r .role "$work_dir/joined.json")" = "member"

curl --fail --silent --show-error --output "$work_dir/channel-members.json" \
  --header "Authorization: Bearer $member_token" "$api_url/api/v1/chats/$channel_id/members"
test "$(jq '.members | length' "$work_dir/channel-members.json")" = "2"
member_channel_code="$(curl --silent --show-error --output "$work_dir/forbidden.json" --write-out '%{http_code}' \
  --request POST --header 'Content-Type: application/json' --header "Authorization: Bearer $member_token" \
  --data '{"kind":"channel","visibility":"public","name":"Forbidden"}' "$api_url/api/v1/chats")"
test "$member_channel_code" = "403"

archive_code="$(curl --silent --show-error --output "$work_dir/archive.json" --write-out '%{http_code}' \
  --request DELETE --header "Authorization: Bearer $owner_token" "$api_url/api/v1/chats/$group_id")"
test "$archive_code" = "204"

curl --fail --silent --show-error --output "$work_dir/owner-chats.json" \
  --header "Authorization: Bearer $owner_token" "$api_url/api/v1/chats"
test "$(jq --arg id "$group_id" '[.chats[].id] | index($id) == null' "$work_dir/owner-chats.json")" = "true"

echo "Phase 1 API smoke test passed."
