.PHONY: build test fmt generate compose-config

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

compose-config:
	docker compose --env-file .env.example -f deploy/compose.yaml config --quiet
