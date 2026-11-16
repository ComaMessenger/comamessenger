#!/usr/bin/env bash
# Backs up a Coma installation into one archive: PostgreSQL dump, files
# (local volume or bundled S3) and .env with the keys. Checks the dump, keeps
# the newest BACKUP_KEEP archives and optionally uploads to S3-compatible
# storage. Settings: backup.env next to this script (see backup.env.example).
#
#   ./backup.sh            # backups/coma-<date>-<version>.tar[.enc]
#
# Cron, every night at 03:15:
#   15 3 * * * cd /opt/coma && ./backup.sh >> backups/backup.log 2>&1
set -euo pipefail
umask 077

cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
. ./lib.sh
require_installation
load_backup_settings

stamp=$(date -u +%Y%m%d-%H%M%S)
version=$(env_value COMA_VERSION)
# Names sort by time: coma-<UTC date>-<version>.
name="coma-${stamp}-${version}"
mkdir -p "$BACKUP_DIR"
work=$(mktemp -d "$BACKUP_DIR/.partial-XXXXXX")
trap 'rm -rf "$work"' EXIT

log "backup $name"
compose ps --status running --services 2>/dev/null | grep -qx postgres ||
  die "PostgreSQL is not running: start Coma with docker compose up -d --wait"

log "database"
compose exec -T postgres pg_dump -U comamessenger -d comamessenger -Fc > "$work/database.dump"
schema=$(compose exec -T postgres psql -U comamessenger -d comamessenger -tAc \
  "SELECT coalesce(max(version_id), 0) FROM goose_db_version WHERE is_applied")
# A dump that pg_restore cannot list is not a backup.
compose exec -T postgres pg_restore --list < "$work/database.dump" > /dev/null ||
  die "the database dump is unreadable"

driver=$(env_value STORAGE_DRIVER)
driver=${driver:-local}
files_note=""
case "$driver" in
  local)
    log "files (local volume)"
    archive_volume files-data "$work/files.tar.gz"
    ;;
  s3)
    if has_profile s3; then
      log "files (bundled S3)"
      archive_volume s3-data "$work/s3-data.tar.gz"
      archive_volume s3-meta "$work/s3-meta.tar.gz"
    else
      files_note="external S3: files are not in this archive; use the provider's versioning or replication"
      log "$files_note"
    fi
    ;;
esac

cp .env "$work/env"
cat > "$work/manifest.txt" <<EOF
coma_version=$version
schema_version=$schema
created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
storage_driver=$driver
profiles=$(env_value COMPOSE_PROFILES)
public_app_url=$(env_value PUBLIC_APP_URL)
${files_note:+note=$files_note}
EOF

archive="$BACKUP_DIR/$name.tar"
tar -C "$work" -cf "$archive.partial" .
if [ -n "${BACKUP_PASSPHRASE_FILE:-}" ]; then
  [ -r "$BACKUP_PASSPHRASE_FILE" ] || die "BACKUP_PASSPHRASE_FILE $BACKUP_PASSPHRASE_FILE is not readable"
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
    -pass "file:$BACKUP_PASSPHRASE_FILE" -in "$archive.partial" -out "$archive.enc.partial"
  rm -f "$archive.partial"
  archive="$archive.enc"
fi
mv "$archive.partial" "$archive"
chmod 0600 "$archive"
log "saved $archive ($(du -h "$archive" | cut -f1))"

# Rotation: the newest BACKUP_KEEP archives stay.
ls -1 "$BACKUP_DIR" | { grep -E '^coma-.*\.tar(\.enc)?$' || true; } | sort -r | tail -n +"$((BACKUP_KEEP + 1))" |
  while read -r file; do
    rm -f -- "$BACKUP_DIR/$file"
    log "removed old $file"
  done

if [ -n "${BACKUP_S3_URL:-}" ]; then
  log "upload to $BACKUP_S3_URL"
  s3_cli cp "/backup/$(basename "$archive")" "${BACKUP_S3_URL%/}/$(basename "$archive")" --only-show-errors
  keep=${BACKUP_S3_KEEP:-$BACKUP_KEEP}
  s3_cli ls "${BACKUP_S3_URL%/}/" | awk '{print $4}' | { grep -E '^coma-.*\.tar(\.enc)?$' || true; } | sort -r |
    tail -n +"$((keep + 1))" | while read -r file; do
      s3_cli rm "${BACKUP_S3_URL%/}/$file" --only-show-errors < /dev/null
      log "removed old $file from S3"
    done
fi
log "done"
