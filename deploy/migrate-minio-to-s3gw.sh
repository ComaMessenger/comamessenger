#!/usr/bin/env bash
# Copies the bucket of the bundled MinIO (--profile s3) to the bundled
# versitygw gateway (--profile s3gw) and verifies keys, sizes and SHA-256 of
# every object. It never deletes or changes anything in MinIO, so switching
# back is a matter of restoring the S3_* settings.
#
# Usage, from the checkout (see docs/runbooks/files-search.md):
#   ./deploy/migrate-minio-to-s3gw.sh            # uses .env
#   ENV_FILE=/path/to/.env ./deploy/migrate-minio-to-s3gw.sh
# COMPOSE_PROJECT_NAME selects another Compose project, as usual.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
env_file="${ENV_FILE:-.env}"
compose=(docker compose --env-file "$env_file" -f deploy/compose.yaml)

value() { grep -E "^$1=" "$env_file" | tail -n 1 | cut -d= -f2-; }
for name in S3_BUCKET S3_GATEWAY_ACCESS_KEY S3_GATEWAY_SECRET_KEY MINIO_ROOT_USER MINIO_ROOT_PASSWORD; do
  if [ -z "$(value "$name")" ]; then
    echo "$name is empty in $env_file" >&2
    exit 1
  fi
done

echo "▶ starting the gateway next to MinIO"
"${compose[@]}" --profile s3 --profile s3gw up -d --wait minio s3gw
"${compose[@]}" --profile s3gw up s3gw-init

echo "▶ copying bucket $(value S3_BUCKET) and verifying it"
# shellcheck disable=SC2016 # expanded inside the container
copy_script='
gateway_key="$AWS_ACCESS_KEY_ID"; gateway_secret="$AWS_SECRET_ACCESS_KEY"
from() { AWS_ACCESS_KEY_ID="$MINIO_ROOT_USER" AWS_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD" aws --endpoint-url http://minio:9000 "$@"; }
to() { AWS_ACCESS_KEY_ID="$gateway_key" AWS_SECRET_ACCESS_KEY="$gateway_secret" aws --endpoint-url http://s3gw:9000 "$@"; }
digest() { (cd "$1" && find . -type f | sort | xargs -r sha256sum); }
mkdir -p /copy/source /copy/check
from s3 sync "s3://$S3_BUCKET" /copy/source --only-show-errors
to s3 sync /copy/source "s3://$S3_BUCKET" --only-show-errors
source_list="$(from s3api list-objects-v2 --bucket "$S3_BUCKET" --query "Contents[].[Key,Size]" --output text | sort)"
target_list="$(to s3api list-objects-v2 --bucket "$S3_BUCKET" --query "Contents[].[Key,Size]" --output text | sort)"
[ "$source_list" = "$target_list" ] || { echo "object lists differ between MinIO and the gateway" >&2; exit 1; }
to s3 sync "s3://$S3_BUCKET" /copy/check --only-show-errors
[ "$(digest /copy/source)" = "$(digest /copy/check)" ] || { echo "object bytes differ" >&2; exit 1; }
echo "copied $(printf "%s\n" "$source_list" | grep -c . || true) objects; keys, sizes and SHA-256 match"
'
# The copy lives in a temporary directory of the one-shot container; make
# sure the Docker host has room for the whole bucket.
"${compose[@]}" --profile s3gw run --rm --no-deps \
  -e MINIO_ROOT_USER="$(value MINIO_ROOT_USER)" -e MINIO_ROOT_PASSWORD="$(value MINIO_ROOT_PASSWORD)" \
  s3gw-init "$copy_script"

cat <<EOF
✔ The gateway holds a verified copy. MinIO was not changed.
Next (docs/runbooks/files-search.md, "Moving from MinIO to the gateway"):
  1. in $env_file set S3_ENDPOINT=http://s3gw:9000, S3_ACCESS_KEY=<S3_GATEWAY_ACCESS_KEY>,
     S3_SECRET_KEY=<S3_GATEWAY_SECRET_KEY>; point the nginx bucket location at coma_s3gw;
  2. docker compose --env-file $env_file -f deploy/compose.yaml up -d --wait core
EOF
