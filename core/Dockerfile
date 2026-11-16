# Core, push relay and mail relay. The Go toolchain runs on the build host's
# architecture and cross-compiles, so a multi-arch build needs no emulation.
FROM --platform=$BUILDPLATFORM golang:1.26.5-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2 AS build

ARG TARGETOS=linux
ARG TARGETARCH
# Release metadata printed by `comamessenger version` and logged on start.
ARG COMA_VERSION=dev
ARG COMA_COMMIT=unknown

WORKDIR /src
COPY core/go.mod ./core/go.mod
COPY core/go.sum ./core/go.sum
COPY go.work ./go.work
RUN cd core && go mod download
COPY core ./core
RUN export CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" \
 && flags="-s -w -X main.version=${COMA_VERSION} -X main.commit=${COMA_COMMIT}" \
 && go build -trimpath -ldflags "$flags" -o /out/comamessenger ./core/cmd/server \
 && go build -trimpath -ldflags "-s -w" -o /out/push-relay ./core/cmd/push-relay \
 && go build -trimpath -ldflags "-s -w" -o /out/mail-relay ./core/cmd/mail-relay

# Push relay run by the Coma project (ADR-0012): docker build --target push-relay
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab AS push-relay

COPY --from=build /out/push-relay /push-relay
EXPOSE 8090
ENTRYPOINT ["/push-relay"]

# Mail relay run by the Coma project (ADR-0013): docker build --target mail-relay
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab AS mail-relay

COPY --from=build /out/mail-relay /mail-relay
EXPOSE 8091
ENTRYPOINT ["/mail-relay"]

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab

COPY --from=build /out/comamessenger /comamessenger
EXPOSE 8080
USER 65532:65532
ENTRYPOINT ["/comamessenger"]
