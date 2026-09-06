# syntax=docker/dockerfile:1
# Multi-stage: compile once, ship a minimal, stateless runtime image
# (ARCHITECTURE.md 40).

FROM golang:1.23-alpine AS builder
WORKDIR /src
COPY services/data-plane/go.mod services/data-plane/go.sum ./
RUN go mod download
COPY services/data-plane/ ./
# CGO off so the binary runs on a distroless/scratch base.
RUN CGO_ENABLED=0 GOOS=linux go build \
      -trimpath -ldflags="-s -w" \
      -o /out/webhookd ./cmd/webhookd

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /out/webhookd /usr/local/bin/webhookd
USER nonroot:nonroot
EXPOSE 8080 9090
ENTRYPOINT ["/usr/local/bin/webhookd"]
CMD ["worker"]
