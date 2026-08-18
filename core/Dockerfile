FROM golang:1.23-alpine AS build

WORKDIR /src
COPY core/go.mod ./core/go.mod
COPY core ./core
COPY go.work ./go.work
RUN CGO_ENABLED=0 go build -o /out/comamessenger ./core/cmd/server

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/comamessenger /comamessenger
EXPOSE 8080
ENTRYPOINT ["/comamessenger"]
