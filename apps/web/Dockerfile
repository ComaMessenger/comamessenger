# Web client: a static build served by unprivileged nginx. The build stage runs
# on the build host's architecture; its output is architecture-independent,
# so a multi-arch image needs no emulation.
FROM --platform=$BUILDPLATFORM node:22.21.1-alpine3.22@sha256:b2358485e3e33bc3a33114d2b1bdb18cdbe4df01bd2b257198eb51beb1f026c5 AS build

WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/agent-runtime/package.json ./apps/agent-runtime/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY packages/tokens/package.json ./packages/tokens/package.json
RUN pnpm install --frozen-lockfile --prod=false --filter @comamessenger/web...

COPY apps/web ./apps/web
COPY packages/core ./packages/core
COPY packages/protocol ./packages/protocol
COPY packages/tokens ./packages/tokens

# The API address is not baked in: /config.js is written at container start.
RUN pnpm --filter @comamessenger/web build

FROM nginxinc/nginx-unprivileged:1.29.3-alpine@sha256:5aea7cc516b419e3526f47dd1531be31a56a046cfe44754d94f9383e13e2ee99

COPY apps/web/docker/templates/ /etc/nginx/templates/
COPY apps/web/docker/coma-security-headers.conf /etc/nginx/coma-security-headers.conf
COPY --chmod=0755 apps/web/docker/15-coma-config.envsh /docker-entrypoint.d/15-coma-config.envsh
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html

# Empty: the API is on the same origin (Core behind the same reverse proxy).
# Otherwise its origin, for example https://api.example.com.
ENV COMA_API_URL=""
EXPOSE 8080
USER 101
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -q -O /dev/null http://127.0.0.1:8080/web-healthz || exit 1
