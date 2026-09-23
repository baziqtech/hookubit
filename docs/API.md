# API contract (v1)

> **Customer-facing reference:** `apps/docs` (the documentation site) carries the
> full integration guide and an API reference generated from the control plane's
> OpenAPI document on every build. This file is the internal summary of the
> contract's shape and its invariants; when the two disagree, the generated
> reference reflects the code and this file needs updating.


Two surfaces, deliberately separate:

- **Ingest API** — Go, `:8080`. Publishers post events. High volume, hot path.
- **Control API** — NestJS, `:3000`. Everything else. OpenAPI at `/docs`
  (JSON at `/docs-json`); the dashboard client is generated from it and request
  and response types are never hand-duplicated (ARCHITECTURE.md 7).

Every public path is versioned under `/v1` from day one. Breaking a v1 contract
is not permitted; add fields, or add v2.

---

## Ingest

### `POST /v1/projects/{project_id}/events`

```http
POST /v1/projects/proj_01J.../events
Authorization: Bearer wk_live_...
Idempotency-Key: order_123_created_v1
Content-Type: application/json

{ "event_type": "order.created",
  "data": { "order_id": "ord_123", "amount": 120.50 },
  "ordering_key": "customer_123" }
```

`202 Accepted`:

```json
{ "id": "evt_01J...", "status": "accepted" }
```

**`accepted` means durably persisted, not delivered.** The response returns once
the event and its outbox row are committed; routing happens afterwards
(ARCHITECTURE.md 16). Delivery is at-least-once and, unless you opt into
ordering, unordered — deduplicate on the event ID.

`ordering_key` is accepted and stored now; per-key serialisation is not yet
enforced (ADR-0004).

Replaying the same `Idempotency-Key` with the same body returns the original
event and `202`. Replaying it with a *different* body is a conflict, not a
silent alias:

```json
{ "error": { "code": "idempotency_key_reused",
             "message": "This idempotency key was used with a different request body",
             "request_id": "req_..." } }
```

---

## Outbound delivery

What a subscribed endpoint receives:

```http
POST /your/webhook/path
Content-Type: application/json
Webhook-Id: evt_01J...
Webhook-Delivery-Id: del_01J...
Webhook-Event-Type: order.created
Webhook-Attempt: 2
Webhook-Timestamp: 1757155200
Webhook-Signature: t=1757155200,v1=<hex>,v1=<hex>
```

Verify by computing `HMAC-SHA256(secret, "<t>.<raw body bytes>")` and comparing
against any `v1` value in constant time. Sign the **exact bytes received** —
re-serialising the JSON first will not match.

Two `v1` signatures appear during a secret rotation window, one per active
secret, so you can adopt the new secret before the old one expires without
dropping a single delivery.

Reject requests whose `t` is outside your tolerance (5 minutes is a reasonable
default) to blunt replay (ARCHITECTURE.md 29).

**Respond `2xx` quickly and do the work asynchronously.** Any of `408`, `429` or
`5xx` is retried with exponential backoff and jitter; other `4xx` responses are
treated as permanent and are not retried. Retries mean duplicates by design, so
consumers must be idempotent — `Webhook-Delivery-Id` is unique per attempt
chain and `Webhook-Id` is stable across every delivery of one event.

---

## Control API shape

```
/v1/auth/{register,login,logout,session,verify-email,resend-verification,
          forgot-password,reset-password,onboarding-completed}
/v1/invitations/accept
/v1/organizations                    …/{orgId}/{projects,members,audit-logs}
/v1/projects/{projectId}/            api-keys · endpoints · subscriptions · retry-policies ·
                                     rate-limits · events · deliveries · outbox · analytics
/v1/projects/{projectId}/events/{eventId}/{deliveries,replay}
/v1/projects/{projectId}/deliveries/{deliveryId}/{attempts,replay}
/v1/projects/{projectId}/outbox/{outboxId}/requeue        (and bulk …/outbox/requeue)
/v1/endpoints/{endpointId}/secrets   …/rotate · …/{secretId}
```

Every project-scoped resource carries `{projectId}` in the path; there are no
flat `/v1/endpoints/{id}`-style routes except the secrets sub-resource, which is
keyed by endpoint alone. There is no "send a test delivery" route: publish a real
event and watch its delivery. The generated reference in `apps/docs/api/` is the
complete list.

Browser sessions use HTTP-only cookies; server-to-server calls use API keys.
No credential is ever stored in `localStorage` (ARCHITECTURE.md 9).

## Errors

Every non-2xx response has the same body, with a stable machine-readable code
(ARCHITECTURE.md 48):

```json
{ "error": { "code": "invalid_request",
             "message": "event_type is required",
             "request_id": "req_01J..." } }
```

`invalid_request` · `unauthenticated` · `email_not_verified` · `forbidden` ·
`not_found` · `conflict` · `idempotency_key_reused` · `payload_too_large` ·
`rate_limited` · `limit_exceeded` · `internal_error`.

Codes are additive. Quote `request_id` in any support conversation; it appears
on every log line for that request.
