# Test server deployment

This runbook describes the current single-host Docker deployment used for the public Coma test environment. It is intentionally simpler than the future production topology.

## Topology

- Nginx terminates TLS on the host.
- Only ports `80` and `443` are public.
- Web, Core API and MinIO bind to `127.0.0.1` through `BIND_ADDRESS`.
- Postgres and MinIO data live in Docker named volumes.
- Long-running services use `restart: unless-stopped` and return after a host reboot.
- Nginx sends `/api/` to Core, including WebSocket upgrade headers for `/api/v1/ws`; the local bucket path goes to MinIO and all other requests go to Web.

The checked-in Nginx template is `deploy/nginx/coma.conf.example`. Replace `__DOMAIN__` and `__CERT_NAME__` when installing it.

## Environment

Create `/opt/coma/.env` with mode `0600`. Never commit the real file. At minimum override:

```dotenv
APP_ENV=production
PUBLIC_APP_URL=https://rocket.hmns-test.ru
PUBLIC_API_URL=https://rocket.hmns-test.ru
BIND_ADDRESS=127.0.0.1
WEB_PORT=5173
WEB_ALLOWED_HOSTS=rocket.hmns-test.ru
AUTH_COOKIE_SECURE=true
BOOTSTRAP_TOKEN=<independent-random-32-byte-secret>
TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128,172.16.0.0/12

POSTGRES_PASSWORD=<random>
DATABASE_URL=postgres://comamessenger:<same-password>@postgres:5432/comamessenger?sslmode=disable
AUTH_SIGNING_KEY=<random>
INTEGRATION_ENCRYPTION_KEY=<independent-random-32-byte-secret>

REDIS_PASSWORD=<random>
REDIS_URL=redis://:<same-password>@redis:6379/0
REDIS_EPHEMERAL_SIGNING_KEY=<independent-random-32-byte-secret>

S3_ENDPOINT=http://minio:9000
S3_PUBLIC_ENDPOINT=https://rocket.hmns-test.ru
S3_BUCKET=coma-test
S3_ACCESS_KEY=<random>
S3_SECRET_KEY=<random>
MINIO_ROOT_USER=<same-access-key>
MINIO_ROOT_PASSWORD=<same-secret-key>
```

Generate independent secrets with a cryptographically secure generator such as `openssl rand -hex 32`. URL-encode the Postgres password before placing it inside `DATABASE_URL` if it contains reserved URL characters.

## First deployment

```bash
git clone https://github.com/ComaMessenger/comamessenger.git /opt/coma
cd /opt/coma
docker compose --env-file .env -f deploy/compose.yaml up -d --build --wait
```

Install the rendered Nginx site, run `nginx -t`, and only then reload Nginx. Keep the existing Certbot certificate when replacing an application behind an established domain.

### First-owner bootstrap

Outside development Core refuses to start without an independent `BOOTSTRAP_TOKEN` of at least 32 bytes. The setup screen asks for this value and sends it only in `X-Coma-Bootstrap-Token`; it is not persisted by the browser. The first successful request creates the organization owner, and all later attempts return `409`.

Keep `/opt/coma/.env` mode `0600`, copy the token from it into the setup screen once, then rotate or remove the value after ownership has been established. If it is removed, keep `APP_ENV=production` and replace it with a new random value before restarting Core because production startup validates the setting.

The Nginx template disables access logging for invitation accept URLs because they contain bearer tokens. Preserve that location when customizing the site.

## Verification

```bash
curl --fail https://rocket.hmns-test.ru/healthz
curl --fail https://rocket.hmns-test.ru/api/v1/bootstrap/status
curl --fail https://rocket.hmns-test.ru/
docker compose --env-file .env -f deploy/compose.yaml ps
```

Run the full smoke suite only before the environment is bootstrapped with data that must be preserved: the Phase 1 smoke script expects an empty database and creates test accounts.

## Update

```bash
cd /opt/coma
git pull --ff-only
docker compose --env-file .env -f deploy/compose.yaml up -d --build --wait
```

After deployment, verify HTTPS and the bootstrap endpoint. Do not run `down -v` during an update: the `-v` flag deletes persistent Postgres and MinIO data.

For delivery incidents use the [realtime diagnostics runbook](runbooks/realtime.md).

## Backups

Before this becomes anything more than a disposable test environment, add scheduled Postgres dumps and an S3/MinIO bucket backup. Docker volumes alone are persistence, not backups.
