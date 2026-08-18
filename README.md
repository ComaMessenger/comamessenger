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

- Go 1.23+
- Node.js 22+
- pnpm 10+
- Docker with Compose v2

## Local start

```sh
cp .env.example .env
docker compose --env-file .env -f deploy/compose.yaml up --build
```

The web application is available at `http://localhost:5173`, the API at `http://localhost:8080`, and the MinIO console at `http://localhost:9001`.

## Local checks

```sh
make test
make build
docker compose --env-file .env.example -f deploy/compose.yaml config --quiet
```

## Status

The repository is at Phase 0. Product behavior is specified, but user-facing functionality has not been implemented yet.
