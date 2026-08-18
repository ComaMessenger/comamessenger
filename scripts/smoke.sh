#!/bin/sh
set -eu

compose_file="deploy/compose.yaml"
env_file="${ENV_FILE:-.env}"

if [ ! -f "$env_file" ]; then
  echo "Missing $env_file. Copy .env.example to .env or set ENV_FILE=.env.example." >&2
  exit 1
fi

docker compose --env-file "$env_file" -f "$compose_file" up -d --build

attempt=0
until curl --fail --silent http://localhost:8080/readyz >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    docker compose --env-file "$env_file" -f "$compose_file" ps
    docker compose --env-file "$env_file" -f "$compose_file" logs core
    echo "ComaMessenger did not become ready in time." >&2
    exit 1
  fi
  sleep 2
done

curl --fail --silent http://localhost:8080/healthz
curl --fail --silent http://localhost:8080/readyz
echo "Smoke test passed."
