# Ingest

The one endpoint on the data plane: where your systems publish events. It is
not part of the control plane's OpenAPI document - it is served by the Go
ingest process, on its own listener - so this page is written by hand from
that implementation. For the narrative (what to publish, how to think about
event types, what `accepted` buys you) read
[Publishing events](/guide/03-publishing-events); this page is the contract.

## `POST /v1/projects/{project_id}/events`

Publish one event into a project. The response returns only after the event
and its fan-out instruction are committed to the database; everything after
that - matching subscriptions, materialising deliveries, the HTTP calls to your
endpoints - happens asynchronously.

```http
POST /v1/projects/proj_01J9Z0H8M4Q1R6T7V8W9X0Y1Z2/events HTTP/1.1
Host: ingest.example.internal
Authorization: Bearer wk_live_3xAmPl3S3cr3tK3yV4lu3Chars32Aa
Content-Type: application/json
Idempotency-Key: order_41f9_settled_v1

{
  "event_type": "payment.settled",
  "data": { "order_id": "ord_41f9", "amount": 12050, "currency": "GHS" },
  "ordering_key": "customer_8821"
}
```

```http
HTTP/1.1 202 Accepted
Content-Type: application/json
X-Request-Id: req_01J9Z0H9A3B4C5D6E7F8G9H0J1

{ "id": "evt_01J9Z0H9A3B4C5D6E7F8G9H0J2", "status": "accepted" }
```

The same call with `curl`:

```bash
curl -sS -X POST "$INGEST_BASE_URL/v1/projects/$PROJECT_ID/events" \
  -H "Authorization: Bearer $WEBHOOK_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order_41f9_settled_v1" \
  -d '{"event_type":"payment.settled","data":{"order_id":"ord_41f9","amount":12050,"currency":"GHS"}}'
```

### Path

| Name | Description |
|---|---|
| `project_id` | The project the key was minted under, `proj_` followed by a ULID. A malformed id, or any other path shape, answers `404 not_found` before authentication is attempted. |

### Request headers

| Header | Required | Rules |
|---|---|---|
| `Authorization` | yes | `Bearer ` followed by the API key exactly as it was returned at creation (`wk_live_...` or `wk_test_...`). The scheme is case-insensitive; the key is not. |
| `Content-Type` | no | If present, must be `application/json` or a `+json` media type; parameters such as `; charset=utf-8` are fine. Absent is accepted. Anything else is `400 invalid_request`. |
| `Idempotency-Key` | no | Up to 255 printable ASCII characters; surrounding whitespace is trimmed. See [Idempotency](#idempotency). |

A client-supplied `X-Request-Id` is **not** honoured here; the ingest endpoint
mints its own and returns it on every response.

### Request body

Exactly one JSON object. Unknown fields are refused, so a misspelt
`event_type` fails now rather than publishing an event nothing subscribes to.

| Field | Type | Required | Rules |
|---|---|---|---|
| `event_type` | string | yes | 1 to 255 characters from `A-Z a-z 0-9 . _ - :`. May not begin or end with a dot. Subscriptions match on this, exactly or by a `prefix.*` pattern, so it is the routing key: use dot-separated, lower-case nouns and verbs (`payment.settled`), and keep identifiers out of it. |
| `data` | any JSON value | yes | The payload your endpoints receive. Conventionally an object. Delivered byte-for-byte as received - HookuBit signs the exact bytes, and never re-serialises your JSON. |
| `ordering_key` | string | no | Up to 255 printable ASCII characters. Stored on the event and carried onto every delivery. **Ordering is not enforced yet**: today this key guarantees nothing about delivery order and is accepted so that producers can start sending it ahead of the feature. |

Two whole-body rules:

- **No NUL characters.** A literal `0x00` byte or a `\u0000` escape anywhere in
  the body is `400 invalid_request`: the database cannot store it, and refusing
  it at validation beats a retry loop that fails the same way forever.
- **Size is measured in raw bytes of the body as received**, before any
  parsing, and the whole body counts - not just `data`.

### Payload limits

| Limit | Default | Behaviour |
|---|---|---|
| Maximum event size | 1,048,576 bytes (1 MiB); operator setting `PAYLOAD_MAX_BYTES` | A larger body is refused with `413 payload_too_large` as soon as the limit is crossed while reading - it is never buffered in full. The message states the limit. |
| Inline threshold | 65,536 bytes (64 KiB); operator setting `PAYLOAD_INLINE_MAX_BYTES` | Bodies **at or above** this are stored in object storage rather than in the database row. Invisible to you, with one exception: if the deployment has no object storage configured, the effective maximum becomes one byte below this threshold, and a larger body is refused with `413 payload_too_large` whose message says exactly that. |

Your operator may have set either value differently; the `413` message always
tells you the ceiling that applied.

### `202 Accepted`

```json
{ "id": "evt_01J9Z0H9A3B4C5D6E7F8G9H0J2", "status": "accepted" }
```

| Field | Meaning |
|---|---|
| `id` | The event id, `evt_` followed by a ULID. It is what `Webhook-Id` carries on every delivery of this event, and what you look up in [Events](./11-events.md) and pass to replay. |
| `status` | Always `accepted`. |

**`accepted` means durably persisted, not delivered.** The event row and its
fan-out instruction are committed, together, before this response is written;
a crash, deploy or failover after that costs latency, never the event. It says
nothing about whether any endpoint has received it - that is what
[Deliveries](./12-deliveries.md) answer. Delivery is at-least-once, so your
receivers must deduplicate on `Webhook-Id`.

When the request is a replay of an earlier one under the same `Idempotency-Key`
(see below), the response is `202` with the **original** event's id - not a new
event.

### Response headers

| Header | When | Value |
|---|---|---|
| `X-Request-Id` | always | `req_` followed by a ULID. Minted per request, on every response including errors, and present on every log line for that request. Quote it when you ask for help. |
| `Content-Type` | always | `application/json`. |
| `Retry-After` | `429` only | Whole seconds to wait, never less than 1. The same number is in `error.details.retry_after_seconds`. |
| `Allow` | `405` only | `POST`. |

### Errors

The body is the [standard envelope](./errors.md#the-envelope). The checks run
in the order the table is grouped in - pre-authentication ceiling, then
authentication, then project resolution, then validation, then rate limiting,
then idempotency, then the write - so the first failing stage is the one you
see.

| Status | `error.code` | When |
|---|---|---|
| `404` | `not_found` | The path is not `/v1/projects/{project_id}/events`, or `project_id` is not a well-formed `proj_` ULID. Answered before authentication. |
| `405` | `invalid_request` | The method is not `POST`. The `Allow` header says so. |
| `429` | `rate_limited` | The **pre-authentication per-address ceiling** was hit. See [Rate limiting](#rate-limiting). |
| `401` | `unauthenticated` | No `Authorization` header, or not a `Bearer` credential ("A bearer API key is required"); or the key is malformed, unknown, revoked or past its `expires_at` (all "Invalid API key" - the causes are deliberately indistinguishable). |
| `404` | `not_found` | The key is valid but was minted under a **different project** than the path names. This is `404`, not `403`, on purpose: confirming that a project exists but is not yours would itself be a disclosure. |
| `403` | `forbidden` | The project is not active (suspended or deleted), or the key's environment (`wk_live_` / `wk_test_`) does not match the project's. |
| `400` | `invalid_request` | `Content-Type` present but not JSON; `Idempotency-Key` too long or not printable ASCII; body empty, unreadable, not exactly one JSON object, or carrying unknown fields; `event_type` missing, too long, containing a disallowed character, or starting or ending with a dot; `ordering_key` too long or not printable ASCII; `data` missing; a NUL character anywhere in the body. The message names the rule. |
| `413` | `payload_too_large` | The body exceeds the maximum event size, or exceeds the inline threshold on a deployment without object storage. The message states the limit that applied. |
| `429` | `rate_limited` | A **policy ceiling** was hit: per API key, per project or per organization. See [Rate limiting](#rate-limiting). |
| `409` | `idempotency_key_reused` | This `Idempotency-Key` was used in the last 24 hours with a **different body**. Nothing was created. |
| `409` | `conflict` | Two requests with the same `Idempotency-Key` are racing: the first has not committed yet ("A request with this idempotency key is still in progress"), or it committed while this one was in flight and the record could not be re-read ("Concurrent request with the same idempotency key; retry"). Safe to retry after a moment. |
| `500` | `internal_error` | The database or object store failed. Nothing was half-written: the event and its fan-out instruction commit together or not at all, so retrying is safe - with the same `Idempotency-Key` if you sent one. |

### Idempotency

Send an `Idempotency-Key` on every publish, and make it a name for the
*operation* your event describes (`order_41f9_settled`), not for the attempt.
Then:

- **Same key, same body, within 24 hours:** `202` with the original event id.
  No second event exists; nothing is delivered twice because of the retry.
- **Same key, different body:** `409 idempotency_key_reused`. The first request
  stands. "Same" is a comparison of the **exact bytes** of the body - a
  reordered field or a changed space is a different body, which is the safe
  direction to be wrong in.
- **Same key, first request still in flight:** `409 conflict`. Retry shortly.
- **After 24 hours** the key is forgotten and may be reused; it then creates a
  new event.
- **No key:** every request creates a new event, including your retries.

Keys are scoped to the project: the same string under two projects is two
keys. Keys are up to 255 printable ASCII characters.

Because the comparison is byte-exact, serialise the body once and send those
same bytes on every retry.

### Rate limiting

Two kinds of ceiling apply, in this order.

**Before authentication, per source address.** A fixed token bucket per client
IP protects the database from an unauthenticated flood. A request that then
fails authentication is charged extra, so a credential-spraying client drains
its bucket an order of magnitude faster than an honest one. It is enforced per
ingest replica. Defaults: 300 requests per second, bursting to 600, with an
authentication failure costing 20 extra tokens (operator settings
`INGEST_SOURCE_RATE_LIMIT`, `INGEST_SOURCE_RATE_LIMIT_BURST`,
`INGEST_SOURCE_AUTH_FAILURE_PENALTY`).

**After validation, by policy.** Every accepted event is charged against up to
three buckets, and all of them must have room - they are nested budgets, not
fallbacks:

1. **Ingest scope** - per API key. The [rate-limit policy](./10-rate-limits.md)
   with `scope: "ingest"` whose `resource_id` names this key; otherwise the
   project's `ingest` policy with no `resource_id`; otherwise the platform
   default of 1,000 events per second per key, bursting to 2,000 (operator
   settings `INGEST_RATE_LIMIT`, `INGEST_RATE_LIMIT_WINDOW_SECONDS`,
   `INGEST_RATE_LIMIT_BURST`).
2. **Project scope** - the project's `project` policy, if one exists.
3. **Organization scope** - the organization's `organization` policy, if one
   exists.

Within one scope the most specific policy wins; across scopes every applicable
policy is charged. Policy changes reach every ingest replica within a bounded
cache interval (30 seconds by default).

A refusal from either kind answers:

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 2
X-Request-Id: req_01J9Z0HA...

{ "error": { "code": "rate_limited", "message": "Rate limit exceeded",
             "request_id": "req_01J9Z0HA...",
             "details": { "retry_after_seconds": 2 } } }
```

Wait `Retry-After` seconds and resend the same request with the same
`Idempotency-Key`. Which ceiling refused is not disclosed. If the rate limiter's
own store is unavailable, the policy limit **fails open** - HookuBit would
rather accept your event than refuse it because of its own outage - while the
per-address ceiling, which is in-process, keeps working.

### What happens next

Once accepted, the event is matched against the project's enabled
[subscriptions](./08-subscriptions.md); each match becomes one
[delivery](./12-deliveries.md) with its own retry chain, signed with the
endpoint's live [signing secret](./07-endpoint-secrets.md) and sent to the
endpoint. An event that matched no subscription is stored and visible in
[Events](./11-events.md) with no deliveries - it is not an error, and a later
subscription does not pick it up retroactively (use replay). An event whose
fan-out could not run sits in the [outbox](./13-outbox.md) until it is requeued.
