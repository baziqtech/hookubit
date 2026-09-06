# Roadmap

Phases follow ARCHITECTURE.md 62. Definition of done for the MVP is
ARCHITECTURE.md 63 — "webhooks can be sent" is not it.

## Phase 1 — Foundation ✅

Monorepo, database model, service skeletons, health probes, dev and production
Docker, CI, ADRs. Signing, retry, SSRF and subscription matching implemented and
unit-tested.

## Phase 2 — Control plane

Users · authentication · organizations · memberships · RBAC · projects · API
keys · endpoints · endpoint secrets · subscriptions · retry policies · rate-limit
policies. OpenAPI published; dashboard client generated from it.

## Phase 3 — Data plane

Ingest (auth → validate → rate limit → idempotency → transactional outbox →
202) · router · delivery creation · scheduler · bounded worker pool · retry
engine · attempt history · state machine · tenant fairness.

## Phase 4 — Security

HMAC wired into delivery · secret rotation with overlap · SSRF enforcement in
the live path · rate limiting · circuit breakers · payload limits · audit logs.

## Phase 5 — Dashboard

Overview · events · deliveries · endpoints · subscriptions · delivery detail with
full attempt history · replay · analytics · team · settings.

The bar for this phase: a human answers "what happened to this event?" at 2am
without opening psql. That is the feature people pay for, not the retry loop.

## Phase 6 — Production hardening

OpenTelemetry traces end to end · Prometheus and Grafana dashboards · graceful
shutdown verified under load · k6 load tests (high fan-out, slow endpoints,
failing endpoints, many tenants, large payloads) · failure-injection tests for
all 20 scenarios in ARCHITECTURE.md 57 · Kubernetes manifests and Helm chart ·
migration job · backup and restore documentation.

## Explicitly not now

Kafka · multi-region · ClickHouse · SAML/enterprise SSO · static egress IPs ·
private network connectors · dedicated tenant databases · payload
transformations · WASM · global routing (ARCHITECTURE.md 61). Interfaces leave
room for each; none blocks the MVP.
