.PHONY: build test fmt generate dev down migrate compose-config smoke

ENV_FILE ?= .env

build:
	go build ./core/...
	pnpm build

test:
	go test ./core/...
	pnpm test

fmt:
	gofmt -w core
	pnpm format

generate:
	pnpm generate
	cd core && GOTOOLCHAIN=auto go tool oapi-codegen --config internal/api/oapi-codegen.yaml ../packages/protocol/openapi.yaml

dev:
	docker compose --env-file $(ENV_FILE) -f deploy/compose.yaml up --build

down:
	docker compose --env-file $(ENV_FILE) -f deploy/compose.yaml down

migrate:
	docker compose --env-file $(ENV_FILE) -f deploy/compose.yaml up -d --wait postgres
	docker compose --env-file $(ENV_FILE) -f deploy/compose.yaml run --rm --no-deps --build core migrate

compose-config:
	docker compose --env-file .env.example -f deploy/compose.yaml config --quiet

smoke:
	ENV_FILE=$(ENV_FILE) ./scripts/smoke.sh
