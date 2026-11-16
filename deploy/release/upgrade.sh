#!/usr/bin/env bash
# Updates Coma to another release: downloads its installation files, checks
# their checksums, makes a backup, then pulls the images and restarts.
#
#   ./upgrade.sh 0.2.0                 # update to v0.2.0
#   ./upgrade.sh --rollback 0.1.0      # back to an older release (docs/upgrade.md)
#
# .env stays as it is; only COMA_VERSION changes. The previous installation
# files are kept in releases/<version>/.
set -euo pipefail
umask 022

cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
. ./lib.sh

REPOSITORY=${COMA_REPOSITORY:-ComaMessenger/comamessenger}
rollback=false
skip_backup=false
target=
for argument in "$@"; do
  case "$argument" in
    --rollback) rollback=true ;;
    --skip-backup) skip_backup=true ;;
    -*) die "unknown option $argument" ;;
    *) target=${argument#v} ;;
  esac
done
[ -n "$target" ] || die "usage: $0 [--rollback] [--skip-backup] <version, e.g. 0.2.0>"
require_installation
load_backup_settings
current=$(env_value COMA_VERSION)

newer() { # true when $1 is a later version than $2; 1.0.0-rc.1 precedes 1.0.0
  local a b
  a=$(printf '%s' "$1" | tr '-' '~')
  b=$(printf '%s' "$2" | tr '-' '~')
  [ "$a" != "$b" ] && [ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | tail -n 1)" = "$a" ]
}
sha256_check() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -c -; else shasum -a 256 -c -; fi
}
if [ "$target" = "$current" ]; then
  log "already on $current; restarting with the same images"
elif newer "$current" "$target" && [ "$rollback" != true ]; then
  die "$target is older than the installed $current. Rolling back is a separate step: read docs/upgrade.md, then run $0 --rollback $target"
fi

files="compose.yaml compose.host-proxy.yaml Caddyfile .env.example generate-env.sh backup.sh restore.sh upgrade.sh lib.sh nginx.conf.example backup.env.example"
download=$(mktemp -d "${TMPDIR:-/tmp}/coma-upgrade.XXXXXX")
trap 'rm -rf "$download"' EXIT

if [ -d "releases/$target" ]; then
  log "using the saved installation files of $target"
  cp -R "releases/$target/." "$download/"
else
  bundle="coma-deploy-$target.tar.gz"
  base="https://github.com/$REPOSITORY/releases/download/v$target"
  log "downloading $base/$bundle"
  curl -fsSL -o "$download/$bundle" "$base/$bundle" || die "release v$target not found"
  curl -fsSL -o "$download/SHA256SUMS" "$base/SHA256SUMS" || die "SHA256SUMS of v$target not found"
  (cd "$download" && grep " $bundle\$" SHA256SUMS | sha256_check >/dev/null) ||
    die "checksum of $bundle does not match: the download is damaged"
  tar -C "$download" -xzf "$download/$bundle" --strip-components 1
  rm -f "$download/$bundle" "$download/SHA256SUMS"
fi
[ -f "$download/compose.yaml" ] || die "the release files have no compose.yaml"

if [ "$skip_backup" != true ] && [ "$target" != "$current" ]; then
  log "backup before the update"
  ./backup.sh || die "backup failed; nothing was changed. Fix it or run with --skip-backup at your own risk"
fi

log "saving the installation files of $current to releases/$current"
mkdir -p "releases/$current"
for file in $files; do
  [ -f "$file" ] && cp -p "$file" "releases/$current/"
done

for file in $files; do
  [ -f "$download/$file" ] && cp "$download/$file" "./$file"
done
chmod +x ./*.sh
set_env_value COMA_VERSION "$target"

log "pulling images of $target"
compose pull --quiet
log "restarting"
if ! compose up -d --wait --wait-timeout 300 --remove-orphans; then
  compose logs --tail 40 core >&2 || true
  cat >&2 <<EOF

Coma $target did not start. Its log is above.
  Back to $current:  ./upgrade.sh --rollback $current
  If Core reports "database schema is newer", restore the backup made a
  moment ago: ./restore.sh $(ls -1 "$BACKUP_DIR"/coma-* 2>/dev/null | sort | tail -n 1)
EOF
  exit 1
fi
log "Coma $target is running ($(compose exec -T core /comamessenger version 2>/dev/null || echo "version unknown"))"
