# shellcheck shell=bash
# Shared helpers of backup.sh, restore.sh and upgrade.sh. Sourced, not run.
# Works with bash 3.2+ and runs every command from the installation directory.

ALPINE_IMAGE=alpine:3.23@sha256:469c9ea410b9215eaee7976ba6c0639039b444be8e5d638f7abbada189971eb2
AWS_CLI_IMAGE=amazon/aws-cli:2.38.6@sha256:bdb0dd07c54dfc7fe6526387dcf23eaab269875a20d647ae4de8196ea04d6bd4

log() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

compose() { docker compose "$@"; }

# Value of KEY in .env (or in the file given as $2), without evaluating it.
env_value() {
  local file=${2:-.env}
  [ -f "$file" ] || return 0
  sed -n "s/^$1=//p" "$file" | tail -n 1
}

# Replaces KEY=... in .env, keeping mode 0600.
set_env_value() {
  local key=$1 value=$2 temporary
  temporary=$(mktemp .env.tmp.XXXXXX)
  awk -v key="$key" -v value="$value" '
    BEGIN { done = 0 }
    index($0, key "=") == 1 { print key "=" value; done = 1; next }
    { print }
    END { if (!done) print key "=" value }
  ' .env > "$temporary"
  chmod 0600 "$temporary"
  mv "$temporary" .env
}

require_installation() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed"
  docker compose version >/dev/null 2>&1 || die "the Docker Compose plugin is missing (apt install docker-compose-plugin)"
  [ -f compose.yaml ] || die "run this script from the Coma directory (compose.yaml is missing)"
  [ -f .env ] || die ".env is missing: create it with ./generate-env.sh <domain>"
}

# Like Compose: the shell variable wins over .env.
project_name() {
  local name=${COMPOSE_PROJECT_NAME:-}
  [ -n "$name" ] || name=$(env_value COMPOSE_PROJECT_NAME)
  printf '%s' "${name:-coma}"
}

has_profile() {
  case ",$(env_value COMPOSE_PROFILES)," in
    *",$1,"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Docker volume of this installation by its name in compose.yaml.
volume_of() {
  local volume
  volume=$(docker volume ls -q \
    --filter "label=com.docker.compose.project=$(project_name)" \
    --filter "label=com.docker.compose.volume=$1" | head -n 1)
  [ -n "$volume" ] || die "volume $1 of project $(project_name) not found: was Coma started here?"
  printf '%s' "$volume"
}

archive_volume() {
  docker run --rm -v "$(volume_of "$1"):/data:ro" "$ALPINE_IMAGE" tar -C /data -czf - . > "$2"
  tar -tzf "$2" > /dev/null || die "archive of $1 is unreadable"
}

restore_volume() {
  docker run --rm -i -v "$(volume_of "$1"):/data" "$ALPINE_IMAGE" \
    sh -ec 'find /data -mindepth 1 -delete; tar -C /data -xzf -' < "$2"
}

load_backup_settings() {
  if [ -f backup.env ]; then
    set -a
    # shellcheck disable=SC1091
    . ./backup.env
    set +a
  fi
  BACKUP_DIR=${BACKUP_DIR:-./backups}
  BACKUP_KEEP=${BACKUP_KEEP:-14}
  case "$BACKUP_KEEP" in
    '' | *[!0-9]* | 0) die "BACKUP_KEEP must be a positive number" ;;
  esac
  mkdir -p "$BACKUP_DIR"
  BACKUP_DIR=$(cd "$BACKUP_DIR" && pwd)
}

# AWS CLI in a container; the backup directory is mounted at /backup.
s3_cli() {
  docker run --rm -i \
    -v "$BACKUP_DIR:/backup" \
    -e AWS_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY:-}" \
    -e AWS_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_KEY:-}" \
    -e AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-us-east-1}" \
    "$AWS_CLI_IMAGE" ${BACKUP_S3_ENDPOINT:+--endpoint-url "$BACKUP_S3_ENDPOINT"} s3 "$@"
}

