#!/usr/bin/env bash
# Store release without store credentials in the cloud:
#   1. asks the store for the next build number (this Mac's App Store Connect
#      key / Play service account),
#   2. compiles the app in GitHub Actions without signing keys,
#   3. downloads the result, signs it here and uploads it.
#
#   apps/mobile/scripts/store-release.sh ios [git-ref]
#   apps/mobile/scripts/store-release.sh android [git-ref]
#
# Needs gh (signed in), bundler and apps/mobile/.env; see
# docs/runbooks/mobile-store-builds.md.
set -euo pipefail

platform="${1:?usage: store-release.sh ios|android [git-ref]}"
case "$platform" in ios|android) ;; *) echo "platform must be ios or android" >&2; exit 2 ;; esac
cd "$(dirname "$0")/.."
ref="${2:-$(git rev-parse --abbrev-ref HEAD)}"
[ -d /opt/homebrew/opt/ruby/bin ] && export PATH="/opt/homebrew/opt/ruby/bin:$PATH"

echo "→ next $platform build number"
number=$(bundle exec fastlane "$platform" next_build 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -o 'NEXT_BUILD=[0-9]*' | tail -1 | cut -d= -f2)
[ -n "$number" ] || { echo "could not get the next build number (run: bundle exec fastlane $platform next_build)" >&2; exit 1; }
echo "  $number"

echo "→ cloud build of $ref"
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh workflow run mobile-release.yml --ref "$ref" -f platform="$platform" -f build_number="$number"
run=""
for _ in $(seq 1 30); do
  run=$(gh run list --workflow mobile-release.yml --event workflow_dispatch --limit 5 \
    --json databaseId,createdAt -q "[.[] | select(.createdAt >= \"$started\")][0].databaseId // empty")
  [ -n "$run" ] && break
  sleep 4
done
[ -n "$run" ] || { echo "the workflow run did not start" >&2; exit 1; }
echo "  https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/actions/runs/$run"
gh run watch "$run" --exit-status --interval 30 >/dev/null

dir="build/ci/$run"
rm -rf "$dir" && mkdir -p "$dir"
gh run download "$run" -n "coma-$platform-$number" -D "$dir"

echo "→ sign and upload"
if [ "$platform" = ios ]; then
  ditto -x -k "$dir/Coma.xcarchive.zip" "$dir"
  bundle exec fastlane ios publish archive:"$PWD/$dir/Coma.xcarchive"
else
  bundle exec fastlane android publish aab:"$PWD/$dir/coma-$number.aab"
fi
