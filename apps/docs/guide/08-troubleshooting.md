# Troubleshooting

"What happened to this event?" - answered from the dashboard, without a database session.

## The path of a question

Every question about a missing or duplicated webhook walks the same four levels. Start at the top and stop when you have the answer.

| Level | Where | What it tells you |
|---|---|---|
| **Event** | *Project → Events*, then the event | Was it accepted, and did routing run? `status`: `received` (accepted, not yet routed), `processing` (routing in progress), `processed` (routing committed), `failed` (parked - see [below](#a-parked-event)). Its `event_type`, `idempotency_key`, `payload_size` and the payload itself. |
| **Deliveries** | The event's *Deliveries* tab, or *Project → Deliveries* filtered by event | Which endpoints the event was routed to - one row each - and the state of each. No row for an endpoint means routing did not target it: see [Nothing arrived](#nothing-arrived). |
| **Delivery** | The delivery detail page | `status`, `attempt_count` / `max_attempts`, `next_attempt_at`, `last_error`, and the event and endpoint it belongs to as they stand now. |
| **Attempts** | Same page, the attempt list | One row per HTTP request: what was sent, what came back, how long it took, and how it was classified. |

Or over the API: `GET …/events/{id}` → `GET …/events/{id}/deliveries` → `GET …/deliveries/{id}` (which inlines up to 100 attempts) → `GET …/deliveries/{id}/attempts` for the rest.

## Reading a delivery

| Field | What to make of it |
|---|---|
| `status` | See the [state machine](./05-retries-and-delivery.md#the-delivery-state-machine). `terminal` says whether anything more will ever happen. |
| `attempt_count` / `max_attempts` | Requests actually made, against the budget frozen onto this delivery at routing. A `scheduled` delivery with `attempt_count: 0` has not been tried yet. |
| `next_attempt_at` | When the next attempt is due. On a terminal delivery it is the time of the last transition and nothing will act on it. |
| `last_error` | The last reason recorded, as the worker phrased it. On a `scheduled` delivery it is the [deferral reason](./05-retries-and-delivery.md#deferred-not-attempted); on `retrying`, `failed` or `exhausted`, the classification of the last attempt. |
| `locked_by` / `locked_until` | A worker holds it. `processing` with `locked_until` in the past means that worker died; the delivery is reclaimed within two minutes. |
| `is_replay`, `replay_of_delivery_id` | This row was created by a [replay](./07-replay.md). |
| `attempts_pruned_at` | See [retention](#retention). |

### `scheduled`, `retrying`, `exhausted`, `failed`, `cancelled` - which is which

| You see | It means | Do |
|---|---|---|
| `scheduled`, `last_error: circuit_breaker_open` | The endpoint's breaker is open; nothing is being sent to it. | Check the endpoint's health on *Endpoints*. Fix the endpoint; the next probe closes the breaker. |
| `scheduled`, `last_error: rate_limited` or `concurrency_limit` | The endpoint's own limits are full. Deliveries are queued, not lost. | Raise `rate_limit` / `max_concurrency` on the endpoint, or wait. |
| `scheduled`, `last_error: payload_unavailable` or `worker_shutdown` | A platform condition, not yours. | Wait; it self-heals. Persistent `payload_unavailable` is an operator issue - quote the delivery id. |
| `retrying` | The endpoint answered `408`, `429` or `5xx`, or did not answer. The next attempt is scheduled. | Read the last attempt. |
| `exhausted`, `attempts_exhausted` | Every attempt in the budget failed retryably. | Fix the endpoint, then replay. |
| `exhausted`, `retry_duration_exhausted` | The wall clock ran out - typically 24 hours behind an open breaker or a long `Retry-After` - possibly with **zero** attempts. | Fix the endpoint, then replay. |
| `failed` | Something a retry cannot fix: another `4xx`, a `3xx`, a bad certificate, a refused URL. | Read `error_code` on the attempt, fix the cause, then replay. |
| `cancelled` | The endpoint was paused, disabled or deleted. | Re-enable the endpoint, then replay. Events published while it was off were not queued for it. |

## Reading an attempt

| Field | Meaning |
|---|---|
| `attempt_number` | 1-based, matches the `Webhook-Attempt` header your receiver saw. |
| `status` | `success` (2xx); `failure` (the endpoint answered and the answer was not 2xx); `timeout` (connected, no answer in time); `error` (never got an answer: DNS, connection, TLS, or a platform-side failure such as signing). **The first thing to look at**: `failure` is your code, `timeout` and `error` are the path to it. |
| `http_status` | The status your endpoint returned, or `null` if none arrived. |
| `duration_ms` | Wall time of the request. Compare with the endpoint's `timeout_ms`. |
| `error_code` | A stable classification, never a raw message - see the table below. |
| `error_message` | The transport's own words, truncated to 1,024 characters. Useful, not stable. |
| `request_headers` | What was sent, `Webhook-Signature` included so you can compare byte for byte. Credential-shaped values are `[redacted]`; the names stay. |
| `response_headers`, `response_body`, `response_size` | What came back. The body is stored up to 64 KiB and marked `…[truncated]` past that; `response_size` is the real size. |
| `worker_id` | Which worker made the request. Relevant only if one replica is misbehaving. |
| `trace_id` | See [trace ids](#trace-ids). |

### Error codes

| `error_code` | Meaning | Retried |
|---|---|---|
| `http_<status>` e.g. `http_500`, `http_403` | The endpoint answered with that status. | `408`, `429`, `5xx` yes; others no |
| `timeout` | Connected, but no response within the limit. | yes |
| `dns` | The hostname did not resolve, or the resolver did not answer in time. | yes |
| `connection` | Refused, reset, unreachable. | yes |
| `transport` | Another transport-level failure, including TLS. Expiry is retried; an untrusted or mismatched certificate is not. | depends |
| `blocked_target` | The platform refused to dial: the URL, or the address it resolved to, is private, loopback, link-local or a metadata service. | no |
| `permanent` | Marked permanent at the point of failure: a request that could not be built, a redirect. | no |
| `signing_failed` | The endpoint had no usable signing secret; nothing was sent. Rotate a secret. | yes |
| `payload_unavailable`, `payload_object_missing`, `payload_hash_mismatch` | The platform could not produce the bytes to send. Not your endpoint's fault; quote the ids to the operator. | the first yes; the others no |

## Nothing arrived

Work down the list; the first row that matches is usually the answer.

| Check | Where | Symptom |
|---|---|---|
| Did the publish get a `202`? | The publisher's logs | No 202 means nothing was accepted. Retry with the same `Idempotency-Key`. |
| Is the event `processed`? | Event detail | `received` for more than a few seconds, or `failed`, means routing has not happened - see [a parked event](#a-parked-event). |
| Is there a delivery for the endpoint? | Event → Deliveries | **No row** means routing skipped it. In order of likelihood: the subscription's `event_types` do not match (remember `payment.*` does not match `payments.x` or bare `payment`); the subscription is disabled; the endpoint is `paused`, `disabled` or `deleted`; the subscription was created after the event was published. |
| Was the endpoint created by a developer? | Endpoint detail | It starts **paused** with `secret_pending` until an owner or admin rotates the secret and enables it. Events published meanwhile were skipped. |
| Is the delivery moving? | Delivery detail | `scheduled` with a deferral reason: see above. `retrying`: read the attempt. |
| Did it reach you and get refused? | Attempt | `http_401`/`http_403` from your own signature check: hash the raw body, check the secret version, check your clock. `http_404`: the path. `http_405`: the method. |
| Is the key rejected on publish? | Publisher's `401` | Wrong environment (`wk_test_` against a `live` project), revoked, expired, or a different project's key (`404`). |

## Duplicates

Expected, by design: at-least-once delivery. The common causes, most to least likely:

1. The publisher retried without an `Idempotency-Key`, creating a second event. Two different `Webhook-Id`s.
2. Your receiver took longer than the timeout to answer; the platform retried while you were still working. Same `Webhook-Delivery-Id`, incrementing `Webhook-Attempt`.
3. A worker died between your `2xx` and recording it. Same delivery id, next attempt number.
4. Someone replayed. Same `Webhook-Id`, new `Webhook-Delivery-Id`, and `is_replay` on the delivery.

The fix is the same in every case: [deduplicate](./04-receiving-webhooks.md#be-idempotent).

## A parked event

An event is **parked** when the router could not route it and gave up - a row that repeatedly kills the router, or a database outage longer than an hour. It shows as `status: failed` on the event and appears on *Project → Outbox* with `last_error`, its attempt counters and `failing_since`. Nothing was delivered, and nothing will be until it is requeued.

**Requeue** (`POST …/outbox/{outboxId}/requeue`, or the bulk route for up to 100 at a time, oldest first) returns the event to the queue and the router runs the routing it never got to run. What to know before pressing it:

- It is **not a replay**. There are no delivery rows yet; requeue creates them.
- The match is bounded to the subscriptions that existed when the event was **accepted**, but with their **current** configuration. A subscription deleted since is gone; one created since does not receive it.
- A routing that was part-way through resumes where it stopped rather than re-sending to endpoints it already reached.
- It needs both `events.replay` and `deliveries.replay`; it is limited to 10 requests per 5 minutes; and it is audited - including a requeue that found nothing to requeue.

## Retention

Two horizons, by default:

| What | Kept for | Then |
|---|---|---|
| Attempt detail - request and response headers, bodies, error messages | **60 days** | Deleted. The delivery's `attempts_pruned_at` is set to the date. |
| The delivery row - status, counts, timestamps, `last_error` | **90 days** | Deleted. |

So a delivery between 60 and 90 days old reads `attempt_count: 5` with an empty attempt list - and `attempts_pruned_at` is what says "we tried five times and the detail was reclaimed on this date" rather than "the platform never tried". Read it before you read `attempts`. Only terminal deliveries are ever pruned; an open one is kept however old it is.

## Trace ids

When the installation exports traces, each attempt that was **sampled** carries `trace_id` - the 32-hex id of that attempt's span in the trace backend. `null` means no trace was kept for that attempt, which is the ordinary case under sampling, not a fault. Each attempt is its own trace; a retry chain is found by searching the backend for the delivery id, not by walking a tree.

## `request_id`

Every error from either API carries `request_id` (`req_…`), and every ingest response carries it as the `X-Request-Id` header, success or failure. It appears on every log line for that request on the platform side. **Quote it** in any support conversation: with it, the operator can go from your screenshot to the exact log lines in seconds; without it, they are searching by timestamp.

---

*Where this comes from:* `apps/dashboard/src/routes/router.tsx` (page paths); `apps/control-api/src/deliveries/dto/delivery-response.dto.ts` (delivery and attempt fields, `attempts_pruned_at`, `trace_id`); `deliveries/delivery-limits.ts` (`MAX_INLINE_ATTEMPTS`, redaction); `events/dto/event-response.dto.ts` (event status); `outbox/dto/*` and `docs/FAILURE_RECOVERY.md` scenario 18 (parked events, requeue semantics); `services/data-plane/internal/worker/state.go` (`ErrorCode`, `classifyAttempt`, reasons); `internal/worker/deliver.go` (`last_error` on deferral, stored body); `internal/router/plan.go` (routing skip reasons); `internal/retention/config.go` (60 and 90 days, `RETENTION_*_AGE_DAYS`); `internal/ingest/handler.go` (`X-Request-Id`); `internal/config/config.go` (`DELIVERY_LEASE_SECONDS`).
