# Agent runtime: TypeScript bundled into one ES module, run by distroless
# Node.js as a non-root user. The bundle is built on the build host's
# architecture and contains no native code.
FROM --platform=$BUILDPLATFORM node:22.21.1-alpine3.22@sha256:b2358485e3e33bc3a33114d2b1bdb18cdbe4df01bd2b257198eb51beb1f026c5 AS build

WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/agent-runtime/package.json ./apps/agent-runtime/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/protocol/package.json ./packages/protocol/package.json
RUN pnpm install --frozen-lockfile --filter @comamessenger/agent-runtime...

COPY apps/agent-runtime ./apps/agent-runtime
COPY packages/core ./packages/core
COPY packages/protocol ./packages/protocol

# Type-check the same way the previous image did, then bundle.
RUN pnpm --filter @comamessenger/protocol build \
    && pnpm --filter @comamessenger/core build \
    && pnpm --filter @comamessenger/agent-runtime build \
    && pnpm --filter @comamessenger/agent-runtime bundle

FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e

WORKDIR /app
COPY --from=build /workspace/apps/agent-runtime/dist/agent-runtime.mjs ./agent-runtime.mjs
USER 65532:65532
CMD ["agent-runtime.mjs"]
