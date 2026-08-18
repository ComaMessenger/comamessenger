FROM node:22-alpine

WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/agent-runtime/package.json ./apps/agent-runtime/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/protocol/package.json ./packages/protocol/package.json
RUN pnpm install --frozen-lockfile

COPY apps/web ./apps/web
COPY packages/core ./packages/core
COPY packages/protocol ./packages/protocol

EXPOSE 5173
CMD ["pnpm", "--filter", "@comamessenger/web", "dev", "--host", "0.0.0.0"]
