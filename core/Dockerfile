FROM golang:1.26.5-alpine AS build

WORKDIR /src
COPY core/go.mod ./core/go.mod
COPY core/go.sum ./core/go.sum
COPY go.work ./go.work
RUN cd core && go mod download
COPY core ./core
RUN CGO_ENABLED=0 go build -o /out/comamessenger ./core/cmd/server \
 && CGO_ENABLED=0 go build -o /out/push-relay ./core/cmd/push-relay

# Push relay run by the Coma project (ADR-0012): docker build --target push-relay
FROM gcr.io/distroless/static-debian12:nonroot AS push-relay

COPY --from=build /out/push-relay /push-relay
EXPOSE 8090
ENTRYPOINT ["/push-relay"]

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/comamessenger /comamessenger
EXPOSE 8080
ENTRYPOINT ["/comamessenger"]
