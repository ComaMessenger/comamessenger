#!/usr/bin/env bash
# Server-side deploy: check out a git ref, rebuild the app images and restart them.
# Run from the checkout on the host: ./deploy/deploy.sh [ref]   (default: origin/main)
# GitHub Actions calls it with the pushed commit SHA (see .github/workflows/deploy.yml).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ref="${1:-origin/main}"
compose=(docker compose --env-file .env -f deploy/compose.yaml)

echo "▶ fetching ${ref}"
git fetch --prune origin
git reset --hard --quiet "${ref}"
echo "  at $(git log --oneline -1)"

echo "▶ building images"
"${compose[@]}" build --pull core web agent-runtime

echo "▶ restarting services"
"${compose[@]}" up -d --remove-orphans --wait --wait-timeout 180 core web agent-runtime

echo "▶ health"
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null http://127.0.0.1:8080/healthz; then
    echo "  core: ok"
    break
  fi
  sleep 2
done
curl -fsS -o /dev/null http://127.0.0.1:8080/healthz || { echo "core is not healthy"; "${compose[@]}" logs --tail 50 core; exit 1; }

"${compose[@]}" ps --format 'table {{.Name}}\t{{.Status}}'
docker image prune -f >/dev/null
echo "✔ deployed $(git rev-parse --short HEAD)"
