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

POSTGRES_PASSWORD=<random>
DATABASE_URL=postgres://comamessenger:<same-password>@postgres:5432/comamessenger?sslmode=disable
AUTH_SIGNING_KEY=<random>

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

### Protect the first-owner bootstrap

An empty public installation must not leave `POST /api/v1/bootstrap` open unattended: the first successful request creates the organization owner. Until the intended owner is ready, temporarily block that exact route in Nginx while leaving `/api/v1/bootstrap/status` available:

```nginx
location = /api/v1/bootstrap {
    return 403;
}
```

Remove the block only while provisioning the first owner, verify that `bootstrap/status` returns `{"bootstrapped":true}`, then keep the route unblocked; Core rejects any later bootstrap attempt with `409`.

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

## Backups

Before this becomes anything more than a disposable test environment, add scheduled Postgres dumps and an S3/MinIO bucket backup. Docker volumes alone are persistence, not backups.
