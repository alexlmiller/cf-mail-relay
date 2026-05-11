# syntax=docker/dockerfile:1.7

FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download || true
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/relay ./cmd/relay

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/relay /relay
EXPOSE 587
USER nonroot:nonroot
ENTRYPOINT ["/relay"]
