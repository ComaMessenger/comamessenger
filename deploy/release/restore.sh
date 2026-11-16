#!/usr/bin/env bash
# Restores a Coma backup made by backup.sh: database, files and the keys from
# its .env. Replaces everything this installation holds now.
#
#   ./restore.sh backups/coma-20261117-031500-0.1.0.tar
#   ./restore.sh --yes backups/coma-….tar.enc     # no confirmation prompt
#
# On a new server: download the installation files, put the archive next to
# them and run this script; ./generate-env.sh is not needed (docs/backup.md).
set -euo pipefail
umask 077

cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
. ./lib.sh

yes=false
archive=
for argument in "$@"; do
  case "$argument" in
    --yes) yes=true ;;
    -*) die "unknown option $argument" ;;
    *) archive=$argument ;;
  esac
done
[ -n "$archive" ] || die "usage: $0 [--yes] <backup archive>"
[ -f "$archive" ] || die "$archive not found"
command -v docker >/dev/null 2>&1 || die "docker is not installed"
[ -f compose.yaml ] || die "run this script from the Coma directory (compose.yaml is missing)"
load_backup_settings

work=$(mktemp -d "${TMPDIR:-/tmp}/coma-restore.XXXXXX")
trap 'rm -rf "$work"' EXIT

case "$archive" in
  *.enc)
    [ -n "${BACKUP_PASSPHRASE_FILE:-}" ] && [ -r "$BACKUP_PASSPHRASE_FILE" ] ||
      die "the archive is encrypted: set BACKUP_PASSPHRASE_FILE in backup.env"
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_PASSPHRASE_FILE" \
      -in "$archive" | tar -C "$work" -xf - || die "cannot decrypt $archive: wrong passphrase?"
    ;;
  *) tar -C "$work" -xf "$archive" ;;
esac
for part in database.dump env manifest.txt; do
  [ -f "$work/$part" ] || die "$archive is not a Coma backup ($part is missing)"
done

backup_version=$(sed -n 's/^coma_version=//p' "$work/manifest.txt")
backup_driver=$(sed -n 's/^storage_driver=//p' "$work/manifest.txt")
current_version=$(env_value COMA_VERSION)
log "backup of Coma $backup_version from $(sed -n 's/^created_at=//p' "$work/manifest.txt")"
grep '^note=' "$work/manifest.txt" | sed 's/^note=/  note: /' || true

if [ "$yes" != true ]; then
  printf 'This replaces the database, files and keys of the installation in %s. Continue? [y/N] ' "$PWD"
  read -r answer
  case "$answer" in y | Y | yes | YES) ;; *) die "cancelled" ;; esac
fi

# Keys and passwords come from the backup: the database and stored secrets
# need them. The version stays the one these installation files are for.
if [ -f .env ]; then
  cp -p .env ".env.before-restore-$(date -u +%Y%m%d-%H%M%S)"
fi
cp "$work/env" .env
chmod 0600 .env
if [ -n "$current_version" ]; then
  set_env_value COMA_VERSION "$current_version"
fi
log "keys restored to .env (Coma $(env_value COMA_VERSION))"

log "stopping Coma"
compose stop >/dev/null 2>&1 || true
compose up -d --wait postgres

# The volume may have been created with another password: align the role
# with the restored .env, then recreate the database from the dump.
password=$(env_value POSTGRES_PASSWORD)
compose exec -T postgres psql -v ON_ERROR_STOP=1 -U comamessenger -d postgres >/dev/null <<SQL
ALTER ROLE comamessenger PASSWORD '${password}';
DROP DATABASE IF EXISTS comamessenger WITH (FORCE);
CREATE DATABASE comamessenger OWNER comamessenger;
SQL
# Creates the volumes of a new installation without starting anything else.
compose create >/dev/null 2>&1
log "database"
compose exec -T postgres pg_restore -U comamessenger -d comamessenger --no-owner --exit-on-error < "$work/database.dump"

case "$backup_driver" in
  local)
    log "files (local volume)"
    restore_volume files-data "$work/files.tar.gz"
    ;;
  s3)
    if [ -f "$work/s3-data.tar.gz" ]; then
      log "files (bundled S3)"
      restore_volume s3-data "$work/s3-data.tar.gz"
      restore_volume s3-meta "$work/s3-meta.tar.gz"
    else
      log "files live in external S3; nothing to restore here"
    fi
    ;;
esac

log "starting Coma"
compose up -d --wait --remove-orphans
log "restored. Open $(env_value PUBLIC_APP_URL) and sign in with an account from the backup."
