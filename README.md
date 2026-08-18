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
packages/core/       Shared TypeScript domain utilities
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

## Local checks

```sh
make test
make build
make generate
docker compose --env-file .env.example -f deploy/compose.yaml config --quiet
```

To verify the complete stack without creating a local `.env`, run:

```sh
ENV_FILE=.env.example make smoke
```

## Status

Phases 0–1 and messaging increments 2.0–2.2a are implemented: authentication, organizations, chats/channels, durable idempotent messages, resumable WebSocket delivery and Redis-assisted realtime with PostgreSQL fallback. The next increment completes thread subscriptions, reactions, pins and snapshot forwarding.
