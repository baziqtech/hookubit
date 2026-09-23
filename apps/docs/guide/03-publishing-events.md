# Publishing events

The ingest contract: one route, one request shape, one response that means exactly one thing, and every way it can refuse you.

## The request

```http
POST /v1/projects/{project_id}/events HTTP/1.1
Host: <your installation's ingest host>
Authorization: Bearer wk_live_…
Idempotency-Key: order_123_created
Content-Type: application/json

{"event_type":"order.created","data":{"order_id":"ord_123","amount":120.5},"ordering_key":"customer_123"}
```

The ingest API is its own service, separate from the control API the dashboard talks to. Its base URL is on your project's *Get started* page. Only `POST` is served on this path; any other method answers `405` with an `Allow: POST` header.

### Headers

| Header | Required | Rules |
|---|---|---|
| `Authorization` | yes | `Bearer` followed by an API key from the project in the path. The key's environment (`wk_test_`/`wk_live_`) must match the project's. |
| `Content-Type` | no | If present, must be `application/json` or a `+json` type; parameters such as `; charset=utf-8` are fine. Absent is accepted. |
| `Idempotency-Key` | no, **strongly recommended** | 1-255 printable ASCII characters. See [Idempotency](#idempotency). |

### Body

A single JSON object with these fields and **no others** - an unknown field (a misspelt `event_type`, say) is refused rather than ignored, so you find out now instead of wondering why nothing was delivered.

| Field | Required | Rules |
|---|---|---|
| `event_type` | yes | 1-255 characters from `A-Z a-z 0-9 . _ - :`. May not begin or end with `.`. Dots are the segment separator that subscription patterns such as `payment.*` match on. |
| `data` | yes | Any JSON value; in practice an object. This is your contract with your receivers - HookuBit never parses it, never re-serialises it, and never sends anything but the bytes you sent. |
| `ordering_key` | no | Up to 255 printable ASCII characters. Stored on the event and carried onto every delivery. **Not yet enforced**: it does not serialise delivery today. |

The whole body may not contain a NUL character, either as a raw byte or as the JSON escape `\u0000`; it cannot be stored and is refused as `invalid_request`.

::: tip The body you send is the body your receivers get
The event is stored as the exact bytes of your request - envelope included - and those bytes are what is signed and delivered. Two requests that differ only in whitespace are two different bodies.
:::

## The response

```http
HTTP/1.1 202 Accepted
Content-Type: application/json
X-Request-Id: req_01M24GHG1AB10B91Z0210MA66J

{"id":"evt_01J…","status":"accepted"}
```

**`accepted` means durably persisted, not delivered.** The response is written only after the event and its routing instruction are committed in one database transaction. From that point the event will be delivered whether or not the ingest process, the network between you and it, or your own process survives the next moment.

Conversely, if you did not get a 202 - a timeout, a dropped connection, a `5xx` - nothing was accepted. Retry with the same `Idempotency-Key`.

`X-Request-Id` is set on every response, success or failure. Log it next to the event id.

## Idempotency

Send an `Idempotency-Key` that is unique per logical event - `order_123_created`, not `order_123` - and retry with the same key whenever you are unsure whether a publish landed.

| You send | HookuBit answers |
|---|---|
| A key it has not seen | Creates the event. `202` with a new `id`. |
| The same key with **the same body** | Returns the **original** event's `id` with `202`. No second event, no second routing. |
| The same key with **a different body** | `409` `idempotency_key_reused`. The first request is not silently aliased and the second is not accepted: this is a client bug - a key reused across two distinct operations - and it is reported as one. |
| The same key while the first request is still in flight | `409` `conflict` with a message saying so. Retry after a moment. |

"Same body" is a comparison of the exact request bytes, not of the parsed JSON. Re-serialising the same object with keys in a different order is a different body and a conflict - the safe direction to be wrong in.

Keys are remembered for **24 hours by default**, scoped to the project. After that a key may be reused and produces a new event.

::: warning Without the header, a retry is a second event
If you retry a publish without an `Idempotency-Key`, HookuBit has no way to know it is a retry. It creates a second event, which routes to the same endpoints as a second set of deliveries. This is the most common source of "unexpected duplicates" and it is not a retry-engine defect.
:::

## Order of checks

The acceptance pipeline runs in a fixed order, which explains which error you get when several things are wrong at once:

1. A per-source-address ceiling, before any credential is read (`429`).
2. Authentication of the API key (`401`).
3. The key's project must be the one in the path (`404`); the project must be active and the key's environment must match it (`403`).
4. Request validation: `Content-Type`, `Idempotency-Key`, body size and shape (`400`, `413`).
5. Rate limiting by API key, project and organization (`429`).
6. Idempotency lookup (`202` replay, or `409`).
7. One transaction: event plus routing instruction. `202`.

## Payload limits

Two thresholds, both set by the operator of your installation:

| Threshold | Default | Effect |
|---|---|---|
| Inline limit | 65,536 bytes (64 KiB) | Bodies **at or above** this size are stored in object storage instead of the database. Nothing about the request or the delivery changes: the same bytes are signed and sent, and your receiver cannot tell the difference. |
| Maximum | 1,048,576 bytes (1 MiB) | Bodies above this are refused with `413` `payload_too_large` before they are fully read. |

If the installation has no object storage configured, the effective maximum is one byte under the inline limit, and the `413` message says exactly that rather than returning a `500`.

## Rate limiting

A refused request answers `429` with both a header and a body field, so a generic HTTP client backs off without knowing anything about HookuBit's error envelope:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 2
Content-Type: application/json

{"error":{"code":"rate_limited","message":"Rate limit exceeded","request_id":"req_…","details":{"retry_after_seconds":2}}}
```

`Retry-After` is in whole seconds, rounded **up** and never below 1, so you are never told to retry immediately.

Several ceilings apply:

| Ceiling | Default | Notes |
|---|---|---|
| Per API key | 1,000 requests/second, burst 2,000 | The built-in ceiling, used when the project has no `ingest` rate-limit policy of its own. A runaway or leaked key is bounded out of the box. |
| Per project, per organization, per ingest policy | none unless configured | Rate-limit policies with scope `ingest`, `project` or `organization`, managed under the project's rate limits. |
| Per source address | 300 requests/second, burst 600 | Applied before authentication. A request that fails authentication is charged extra (20 by default), so a key-spraying flood exhausts its budget quickly while honest traffic does not notice. |

If the limiter's store is unreachable the platform **fails open**: traffic is accepted rather than refused. A rate limit is throughput control here, not the source of truth.

## Errors

Every non-2xx response has the same envelope. Match on `code`; the `message` is for humans and may be reworded.

```json
{
  "error": {
    "code": "invalid_request",
    "message": "event_type is required",
    "request_id": "req_01J…",
    "details": { }
  }
}
```

`details` is present only when there is a number to act on; today the only key is `retry_after_seconds` on a `429`.

| HTTP | `code` | When |
|---|---|---|
| 400 | `invalid_request` | The body is not a single JSON object with the documented fields; `event_type` missing or malformed; `ordering_key` or `Idempotency-Key` too long or not printable ASCII; `Content-Type` not JSON; a NUL character; a method other than `POST`; the body could not be read. |
| 401 | `unauthenticated` | No bearer credential, or a key that is malformed, unknown, revoked or expired. All four read `Invalid API key`, deliberately: telling an attacker which it was is an oracle. |
| 403 | `forbidden` | The key is valid but the project is not active, or the key's environment does not match the project's. |
| 404 | `not_found` | The path is not `/v1/projects/{proj_…}/events`, or the key belongs to a different project. The second case is a 404 rather than a 403 because confirming that a project exists is itself a disclosure. |
| 409 | `conflict` | Another request with the same `Idempotency-Key` is in progress. Retry. |
| 409 | `idempotency_key_reused` | The `Idempotency-Key` was used before with a different body. Do not retry; fix the key. |
| 413 | `payload_too_large` | The body exceeds the maximum event size, or the installation has no object storage and the body is at or above the inline limit. |
| 429 | `rate_limited` | A ceiling was hit. Honour `Retry-After`. |
| 500 | `internal_error` | Something on the platform's side. Nothing was accepted; retry with the same `Idempotency-Key`. Quote the `request_id` if it persists. |

Codes are additive: new ones may appear, existing ones are never renamed or reused.

## A publisher checklist

- Generate the `Idempotency-Key` from the thing that happened, store it with that thing, and reuse it on every retry of the same publish.
- Treat anything other than a 202 as "not accepted". Retry `429` after `Retry-After`, retry `500` and network failures with backoff, and **do not** retry `400`, `401`, `403`, `404`, `413` or `idempotency_key_reused` - they will fail identically.
- Publish after your own transaction commits, not inside it. A 202 is a promise the platform keeps even if you roll back.
- Keep `data` a JSON contract, not a serialised class from your framework.

---

*Where this comes from:* `services/data-plane/internal/ingest/handler.go` (pipeline order, `X-Request-Id`, 405); `internal/ingest/request.go` (envelope validation, limits on `event_type`, `ordering_key`, `Idempotency-Key`, NUL rejection, `Content-Type`); `internal/ingest/idempotency.go` (`Decide`, 24h TTL); `internal/ingest/payload.go` (inline vs offload, the no-object-storage message); `internal/ingest/errors.go` (codes, envelope, `Retry-After` rounding); `internal/ingest/apikey.go` (key shape, environments); `internal/config/config.go` (`PAYLOAD_INLINE_MAX_BYTES`, `PAYLOAD_MAX_BYTES`, `INGEST_RATE_LIMIT*`, `INGEST_SOURCE_RATE_LIMIT*`, `INGEST_SOURCE_AUTH_FAILURE_PENALTY`); `apps/control-api/src/rate-limits/rate-limit-limits.ts` (policy scopes); `docs/API.md`. The 401 and 405 responses shown were produced by a local ingest instance.
