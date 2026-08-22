#!/bin/sh
set -eu

mode=development
if [ "${1:-}" = "--production" ]; then
  mode=production
  shift
fi

target=${1:-.env}
if [ -e "$target" ]; then
  echo "Refusing to overwrite existing $target" >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to generate installation secrets" >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_file="$script_dir/../.env.example"
target_dir=$(dirname -- "$target")
mkdir -p "$target_dir"
temporary=$(mktemp "$target.tmp.XXXXXX")
trap 'rm -f "$temporary"' EXIT HUP INT TERM
umask 077

postgres_password=$(openssl rand -hex 32)
redis_password=$(openssl rand -hex 32)
auth_signing_key=$(openssl rand -hex 32)
integration_key=$(openssl rand -hex 32)
bootstrap_token=$(openssl rand -hex 32)
redis_signing_key=$(openssl rand -hex 32)
runtime_key="coma_agent_$(openssl rand -hex 32)"

awk \
  -v mode="$mode" \
  -v postgres_password="$postgres_password" \
  -v redis_password="$redis_password" \
  -v auth_signing_key="$auth_signing_key" \
  -v integration_key="$integration_key" \
  -v bootstrap_token="$bootstrap_token" \
  -v redis_signing_key="$redis_signing_key" \
  -v runtime_key="$runtime_key" '
  /^APP_ENV=/ { print "APP_ENV=" mode; next }
  /^AUTH_COOKIE_SECURE=/ { print "AUTH_COOKIE_SECURE=" (mode == "production" ? "true" : "false"); next }
  /^POSTGRES_PASSWORD=/ { print "POSTGRES_PASSWORD=" postgres_password; next }
  /^DATABASE_URL=/ { print "DATABASE_URL=postgres://comamessenger:" postgres_password "@postgres:5432/comamessenger?sslmode=disable"; next }
  /^REDIS_PASSWORD=/ { print "REDIS_PASSWORD=" redis_password; next }
  /^REDIS_URL=/ { print "REDIS_URL=redis://:" redis_password "@redis:6379/0"; next }
  /^AUTH_SIGNING_KEY=/ { print "AUTH_SIGNING_KEY=" auth_signing_key; next }
  /^INTEGRATION_ENCRYPTION_KEY=/ { print "INTEGRATION_ENCRYPTION_KEY=" integration_key; next }
  /^BOOTSTRAP_TOKEN=/ { print "BOOTSTRAP_TOKEN=" bootstrap_token; next }
  /^REDIS_EPHEMERAL_SIGNING_KEY=/ { print "REDIS_EPHEMERAL_SIGNING_KEY=" redis_signing_key; next }
  /^AGENT_RUNTIME_API_KEY=/ { print "AGENT_RUNTIME_API_KEY=" runtime_key; next }
  { print }
' "$source_file" > "$temporary"

chmod 0600 "$temporary"
mv "$temporary" "$target"
trap - EXIT HUP INT TERM
echo "Created $target with mode 0600. Secrets were not printed."
if [ "$mode" = "production" ]; then
  echo "Set PUBLIC_APP_URL, PUBLIC_API_URL, WEB_ALLOWED_HOSTS and TLS-related values before starting the public server."
fi
