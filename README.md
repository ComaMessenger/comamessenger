# ComaMessenger

Open-source self-hosted corporate messenger with chats, read-only channels, threads and an agent-first architecture.

The product specification and phased implementation plan live in [`docs/`](docs/README.md).

## License

The Go server and agent runtime use `AGPL-3.0-only`. Clients, protocol packages, deployment assets and documentation use `Apache-2.0`. See [`LICENSE`](LICENSE) for the directory-level map and [`LICENSES/`](LICENSES/) for the complete terms.

## Repository layout

```text
core/                Go server
apps/web/            React web client
apps/agent-runtime/  TypeScript agent runtime
packages/protocol/   OpenAPI contract and generated clients
packages/core/       Platform-neutral client engine (API/realtime/store/outbox/markdown)
packages/tokens/     Shared light/dark design tokens
deploy/              Local and production deployment assets
docs/                Product, architecture and phase documents
```

## Prerequisites

- Go 1.26.5+
- Node.js 22+
- pnpm 10+
- Docker with Compose v2

## Local start

```sh
cp .env.example .env
docker compose --env-file .env -f deploy/compose.yaml up --build
```

The web application is available at `http://localhost:5173`, the API at `http://localhost:8080`, and the MinIO console at `http://localhost:9001`. PostgreSQL is the source of truth; the bundled Redis process provides realtime coordination and is not exposed outside the Compose network. If port 5173 is occupied, set `WEB_PORT` in `.env` before starting Compose.

Web Push is optional. Generate VAPID keys with `docker compose --env-file .env -f deploy/compose.yaml run --rm --no-deps core vapid`, copy the two emitted variables into `.env`, set `VAPID_SUBJECT`, and restart Core.

## Local checks

```sh
make test
make build
make generate
pnpm --filter @comamessenger/web test:e2e
docker compose --env-file .env.example -f deploy/compose.yaml config --quiet
```

To verify the complete stack without creating a local `.env`, run:

```sh
ENV_FILE=.env.example make smoke
```

## Status

Phases 0–3.1 are implemented: authentication and organizations; chats, channels, messages and threads; durable resumable realtime with Redis coordination; the responsive RU/EN Web client; and full-screen profile, workspace, branding, infrastructure, sessions and audit settings. The next planned phase connects the configured S3-compatible storage to attachments and adds search.
