FROM node:22-alpine

WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/agent-runtime/package.json ./apps/agent-runtime/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/protocol/package.json ./packages/protocol/package.json
RUN pnpm install --frozen-lockfile

COPY apps/agent-runtime ./apps/agent-runtime
COPY packages/core ./packages/core
COPY packages/protocol ./packages/protocol

RUN pnpm --filter @comamessenger/protocol build \
    && pnpm --filter @comamessenger/core build \
    && pnpm --filter @comamessenger/agent-runtime build

USER node
CMD ["./apps/agent-runtime/node_modules/.bin/tsx", "apps/agent-runtime/src/index.ts"]
