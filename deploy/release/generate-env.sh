#!/bin/sh
# Creates .env for a new Coma installation: independent random secrets, the
# public address and mode 0600. Never overwrites an existing .env and never
# prints secrets.
#
#   ./generate-env.sh chat.example.com           # HTTPS with an automatic certificate
#   ./generate-env.sh --agents chat.example.com  # plus the bundled agent runtime
#   ./generate-env.sh --s3 chat.example.com      # files in the bundled S3 instead of a volume
#   ./generate-env.sh localhost:8088             # trial on this computer over plain HTTP
set -eu

usage() {
  echo "Usage: $0 [--agents] [--s3] <domain | localhost[:port]>" >&2
  exit 2
}

agents=false
s3=false
domain=
while [ $# -gt 0 ]; do
  case "$1" in
    --agents) agents=true ;;
    --s3) s3=true ;;
    -h | --help) usage ;;
    -*) echo "Unknown option $1" >&2; usage ;;
    *) [ -z "$domain" ] || usage; domain=$1 ;;
  esac
  shift
done
[ -n "$domain" ] || usage

cd "$(dirname -- "$0")"
target=.env
if [ -e "$target" ]; then
  echo "$target already exists: the installation's secrets live there. Not touching it." >&2
  exit 1
fi
[ -f .env.example ] || { echo ".env.example is missing next to $0" >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "openssl is required (apt install openssl)" >&2; exit 1; }

domain=$(printf '%s' "$domain" | sed -e 's#^https\{0,1\}://##' -e 's#/*$##')
trial=false
case "$domain" in
  localhost | localhost:*)
    trial=true
    port=${domain#localhost}
    port=${port#:}
    site_address=http://localhost
    public_url="http://localhost${port:+:$port}"
    http_port=${port:-80}
    mail_domain=localhost
    ;;
  *)
    if ! printf '%s' "$domain" | grep -Eq '^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$'; then
      echo "\"$domain\" does not look like a domain name, for example chat.example.com" >&2
      exit 1
    fi
    site_address=$domain
    public_url="https://$domain"
    http_port=80
    mail_domain=$domain
    ;;
esac

profiles=caddy
[ "$agents" = true ] && profiles="$profiles,agents"
[ "$s3" = true ] && profiles="$profiles,s3"

umask 077
temporary=$(mktemp ".env.tmp.XXXXXX")
trap 'rm -f "$temporary"' EXIT HUP INT TERM

secret() { openssl rand -hex 32; }

awk \
  -v profiles="$profiles" \
  -v site_address="$site_address" \
  -v public_url="$public_url" \
  -v http_port="$http_port" \
  -v cookie_secure="$([ "$trial" = true ] && echo false || echo true)" \
  -v vapid_subject="mailto:admin@$mail_domain" \
  -v s3="$s3" \
  -v postgres_password="$(secret)" \
  -v redis_password="$(secret)" \
  -v auth_signing_key="$(secret)" \
  -v integration_key="$(secret)" \
  -v bootstrap_token="$(secret)" \
  -v redis_signing_key="$(secret)" \
  -v runtime_key="coma_agent_$(secret)" \
  -v s3_access_key="coma$(openssl rand -hex 8)" \
  -v s3_secret_key="$(secret)" '
  /^COMPOSE_PROFILES=/ { print "COMPOSE_PROFILES=" profiles; next }
  /^COMA_SITE_ADDRESS=/ { print "COMA_SITE_ADDRESS=" site_address; next }
  /^PUBLIC_APP_URL=/ { print "PUBLIC_APP_URL=" public_url; next }
  /^HTTP_PORT=/ { print "HTTP_PORT=" http_port; next }
  /^AUTH_COOKIE_SECURE=/ { print "AUTH_COOKIE_SECURE=" cookie_secure; next }
  /^VAPID_SUBJECT=/ { print "VAPID_SUBJECT=" vapid_subject; next }
  /^POSTGRES_PASSWORD=/ { print "POSTGRES_PASSWORD=" postgres_password; next }
  /^REDIS_PASSWORD=/ { print "REDIS_PASSWORD=" redis_password; next }
  /^AUTH_SIGNING_KEY=/ { print "AUTH_SIGNING_KEY=" auth_signing_key; next }
  /^INTEGRATION_ENCRYPTION_KEY=/ { print "INTEGRATION_ENCRYPTION_KEY=" integration_key; next }
  /^BOOTSTRAP_TOKEN=/ { print "BOOTSTRAP_TOKEN=" bootstrap_token; next }
  /^REDIS_EPHEMERAL_SIGNING_KEY=/ { print "REDIS_EPHEMERAL_SIGNING_KEY=" redis_signing_key; next }
  /^AGENT_RUNTIME_API_KEY=/ { print "AGENT_RUNTIME_API_KEY=" runtime_key; next }
  s3 == "true" && /^STORAGE_DRIVER=/ { print "STORAGE_DRIVER=s3"; next }
  s3 == "true" && /^S3_ENDPOINT=/ { print "S3_ENDPOINT=http://s3gw:9000"; next }
  s3 == "true" && /^S3_PUBLIC_ENDPOINT=/ { print "S3_PUBLIC_ENDPOINT=" public_url; next }
  s3 == "true" && /^S3_BUCKET=/ { print "S3_BUCKET=comamessenger"; next }
  s3 == "true" && /^S3_FORCE_PATH_STYLE=/ { print "S3_FORCE_PATH_STYLE=true"; next }
  s3 == "true" && /^S3_ACCESS_KEY=/ { print "S3_ACCESS_KEY=" s3_access_key; next }
  s3 == "true" && /^S3_SECRET_KEY=/ { print "S3_SECRET_KEY=" s3_secret_key; next }
  { print }
' .env.example > "$temporary"

if grep -q '^COMA_VERSION=__COMA_VERSION__' "$temporary"; then
  echo "COMA_VERSION is not set in .env.example: download the installation files of a release (docs/install.md)." >&2
  exit 1
fi

chmod 0600 "$temporary"
mv "$temporary" "$target"
trap - EXIT HUP INT TERM
echo "Created .env (mode 0600) for $public_url. Secrets were not printed."

# Web Push keys come from Core itself; this also downloads the Core image.
if command -v docker >/dev/null 2>&1; then
  echo "Generating Web Push keys (downloads the Core image on the first run)…"
  if keys=$(docker compose run --rm --no-deps --quiet-pull core vapid 2>/dev/null) &&
    printf '%s\n' "$keys" | grep -q '^VAPID_PUBLIC_KEY=.'; then
    public=$(printf '%s\n' "$keys" | sed -n 's/^VAPID_PUBLIC_KEY=//p')
    private=$(printf '%s\n' "$keys" | sed -n 's/^VAPID_PRIVATE_KEY=//p')
    updated=$(mktemp ".env.tmp.XXXXXX")
    awk -v public="$public" -v private="$private" '
      /^VAPID_PUBLIC_KEY=/ { print "VAPID_PUBLIC_KEY=" public; next }
      /^VAPID_PRIVATE_KEY=/ { print "VAPID_PRIVATE_KEY=" private; next }
      { print }
    ' "$target" > "$updated"
    chmod 0600 "$updated"
    mv "$updated" "$target"
    echo "Web Push keys added."
  else
    echo "Could not run the Core image; Web Push stays off. Later: docker compose run --rm --no-deps core vapid, then copy both lines into .env." >&2
  fi
fi

if [ "$trial" = true ]; then
  echo "Trial mode over plain HTTP: the mobile app, Coma mail and Web Push need a real domain with HTTPS."
fi
echo "Next: docker compose up -d --wait, then open $public_url"
