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
mkdir -p /copy
# Object by object, so each keeps its Content-Type (a sync through a local
# directory guesses it from the file name, and Core keys have no extension).
from s3api list-objects-v2 --bucket "$S3_BUCKET" --query "Contents[].Key" --output json \
  | sed -n "s/^ *\"\(.*\)\",\{0,1\}$/\1/p" > /copy/keys
count=0
while IFS= read -r key; do
  type="$(from s3api head-object --bucket "$S3_BUCKET" --key "$key" --query ContentType --output text)"
  from s3api get-object --bucket "$S3_BUCKET" --key "$key" /copy/object >/dev/null
  to s3api put-object --bucket "$S3_BUCKET" --key "$key" --body /copy/object --content-type "$type" >/dev/null
  source_sum="$(sha256sum < /copy/object)"
  to s3api get-object --bucket "$S3_BUCKET" --key "$key" /copy/check >/dev/null
  copied_type="$(to s3api head-object --bucket "$S3_BUCKET" --key "$key" --query ContentType --output text)"
  [ "$source_sum" = "$(sha256sum < /copy/check)" ] || { echo "bytes differ for $key" >&2; exit 1; }
  [ "$type" = "$copied_type" ] || { echo "Content-Type differs for $key: $type / $copied_type" >&2; exit 1; }
  count=$((count + 1))
done < /copy/keys
source_list="$(from s3api list-objects-v2 --bucket "$S3_BUCKET" --query "Contents[].[Key,Size]" --output text | sort)"
target_list="$(to s3api list-objects-v2 --bucket "$S3_BUCKET" --query "Contents[].[Key,Size]" --output text | sort)"
[ "$source_list" = "$target_list" ] || { echo "object lists differ between MinIO and the gateway" >&2; exit 1; }
echo "copied $count objects; keys, sizes, Content-Type and SHA-256 match"
'
# Each object passes through a temporary file of the one-shot container; the
# Docker host needs room for the largest object.
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
