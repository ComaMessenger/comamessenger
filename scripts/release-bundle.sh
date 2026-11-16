#!/usr/bin/env bash
# Builds the installation files of a release from deploy/release:
#   <out>/coma-deploy-<version>.tar.gz   (top directory coma-<version>/)
#   <out>/SHA256SUMS
# Image references are pinned to the published digests. For a local check of
# images that are not in a registry, COMA_BUNDLE_REGISTRY=<prefix> and
# COMA_BUNDLE_UNPINNED=1 keep plain tags.
#
#   ./scripts/release-bundle.sh 0.1.0 dist
set -euo pipefail

version=${1:?usage: $0 <version> <output directory>}
out=${2:?usage: $0 <version> <output directory>}
registry=${COMA_BUNDLE_REGISTRY:-ghcr.io/comamessenger}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
mkdir -p "$out"
out=$(cd "$out" && pwd)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
dir="$stage/coma-$version"
mkdir -p "$dir"

files="compose.yaml compose.host-proxy.yaml Caddyfile .env.example generate-env.sh backup.sh restore.sh upgrade.sh lib.sh nginx.conf.example backup.env.example"
for file in $files; do
  cp "$root/deploy/release/$file" "$dir/$file"
done

reference() {
  local image="$registry/$1:$version" digest
  if [ "${COMA_BUNDLE_UNPINNED:-}" = 1 ]; then
    printf '%s' "$image"
    return
  fi
  digest=$(docker buildx imagetools inspect "$image" --format '{{json .Manifest.Digest}}' | tr -d '"')
  case "$digest" in sha256:*) ;; *) echo "no digest for $image" >&2; exit 1 ;; esac
  printf '%s@%s' "$image" "$digest"
}

core=$(reference coma-core)
web=$(reference coma-web)
runtime=$(reference coma-agent-runtime)
awk -v core="$core" -v web="$web" -v runtime="$runtime" '
  /^x-image-core:/ { print "x-image-core: &image-core " core; next }
  /^x-image-web:/ { print "x-image-web: &image-web " web; next }
  /^x-image-agent-runtime:/ { print "x-image-agent-runtime: &image-agent-runtime " runtime; next }
  { print }
' "$root/deploy/release/compose.yaml" > "$dir/compose.yaml"
grep -q "coma-core:$version" "$dir/compose.yaml" || { echo "image references were not replaced" >&2; exit 1; }
sed "s/^COMA_VERSION=__COMA_VERSION__\$/COMA_VERSION=$version/" "$root/deploy/release/.env.example" > "$dir/.env.example"
grep -q "^COMA_VERSION=$version\$" "$dir/.env.example" || { echo "COMA_VERSION was not set" >&2; exit 1; }
chmod 0755 "$dir"/*.sh
chmod 0644 "$dir/compose.yaml" "$dir/compose.host-proxy.yaml" "$dir/Caddyfile" "$dir/.env.example" "$dir/nginx.conf.example" "$dir/backup.env.example"

bundle="coma-deploy-$version.tar.gz"
tar -C "$stage" -czf "$out/$bundle" "coma-$version"
(cd "$out" && { command -v sha256sum >/dev/null && sha256sum "$bundle" || shasum -a 256 "$bundle"; } > SHA256SUMS)
echo "$out/$bundle"
cat "$out/SHA256SUMS"
