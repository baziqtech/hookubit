# Glossary

Terms that carry weight in HookuBit, with the page that explains each.

| Term | Meaning |
|---|---|
| **Attempt** | One HTTP request made for a delivery. Append-only: the request headers, the response, `http_status`, `duration_ms`, an `error_code` and, when sampled, a `trace_id`. Numbered from 1; the number is sent as `Webhook-Attempt`. [08](./08-troubleshooting.md#reading-an-attempt) |
| **Auto-disable** | The platform switching off an endpoint whose circuit breaker has been open continuously for 72 hours (by default). Sets `status: disabled` and a `disabled_reason` beginning `auto-disabled:`; routing stops creating deliveries for it. Re-enabling arms one probe. [05](./05-retries-and-delivery.md#auto-disable) |
| **Circuit breaker** | Per-endpoint health that removes delivery pressure after 5 consecutive qualifying failures (transport errors, timeouts, `408`, `429`, `5xx`). States: `healthy`, `degraded`, `open`, `half_open`. Cooldown 30 s doubling to 10 min. [05](./05-retries-and-delivery.md#the-circuit-breaker) |
| **Deferred** | A delivery put back into the queue **without** a request being made and without spending an attempt: the breaker was open, a limit was full, the worker was restarting. Shows as `scheduled` with the reason in `last_error`. The wall clock still runs. [05](./05-retries-and-delivery.md#deferred-not-attempted) |
| **Delivery** | One (event, endpoint) pair with its own state, retry budget and attempt history. Created by routing; identified by `del_…` and sent as `Webhook-Delivery-Id`. [01](./01-concepts.md) |
| **Endpoint** | A URL you own that receives webhooks, with its signing secrets, timeout, concurrency, rate limit and custom headers. `ep_…`. [04](./04-receiving-webhooks.md) |
| **Event** | One published fact: `event_type`, `data`, optional `ordering_key`. Stored once as the exact bytes received; `evt_…`, sent as `Webhook-Id`. [03](./03-publishing-events.md) |
| **Event type** | A dot-separated name such as `payment.settled`. Subscriptions match it with `*`, `prefix.*` or an exact type. [01](./01-concepts.md#the-hierarchy) |
| **Exhausted** | A terminal delivery state: retryable failures until the budget ran out, by count (`attempts_exhausted`) or by wall clock (`retry_duration_exhausted`). [05](./05-retries-and-delivery.md#the-delivery-state-machine) |
| **Half-open probe** | The single delivery admitted to a recovering endpoint when its breaker's cooldown ends - one across the whole fleet. Success (2 in a row by default) closes the breaker; failure re-opens it. [05](./05-retries-and-delivery.md#the-circuit-breaker) |
| **Idempotency key** | The `Idempotency-Key` header on a publish: same key and same body returns the original event; same key and different body is `idempotency_key_reused`. Remembered for 24 hours by default. [03](./03-publishing-events.md#idempotency) |
| **Inline limit** | The body size (64 KiB by default) at or above which a payload is offloaded to object storage instead of the database. Invisible to publisher and receiver. [03](./03-publishing-events.md#payload-limits) |
| **Offload** | Storing a large payload in object storage rather than inline. The same bytes are signed and delivered. [03](./03-publishing-events.md#payload-limits) |
| **Ordering key** | An optional `ordering_key` on a published event, validated and stored and carried onto each delivery, but **not yet enforced**: deliveries are unordered today. [01](./01-concepts.md#the-two-guarantees) |
| **Overlap window** | The period after a secret rotation in which both old and new secrets sign, so every delivery carries two `v1=` signatures and a receiver holding either verifies. 24 hours by default, 0 for a leak, up to 30 days. [06](./06-secrets-and-rotation.md#rotation) |
| **Park / requeue** | An event the router gave up routing is *parked* (`status: failed`, listed on *Outbox*); *requeue* returns it to the queue so routing runs. Not a replay: there were no deliveries to replay. [08](./08-troubleshooting.md#a-parked-event) |
| **Replay** | Creating a **new** delivery for the same event and endpoint - new `Webhook-Delivery-Id`, same `Webhook-Id`, attempt count restarting at 1, the original untouched. Per delivery, or to every endpoint an event originally reached (50 per request at most). [07](./07-replay.md) |
| **Retry policy** | The schedule frozen onto a delivery at routing: strategy, attempts, delays, jitter, wall-clock budget. Per endpoint, with a project default and a built-in default. [05](./05-retries-and-delivery.md#the-default-schedule) |
| **Routing** | Turning one accepted event into one delivery row per matching enabled subscription, as they existed when the event was accepted. Exactly-once per (event, endpoint). [01](./01-concepts.md#the-path-of-an-event) |
| **Signing secret** | `whsec_…`, the HMAC-SHA256 key for an endpoint. Returned once at creation or rotation; versioned; several may be active at once. [06](./06-secrets-and-rotation.md) |
| **Subscription** | Binds an endpoint to a set of event-type patterns. A disabled subscription matches nothing. `sub_…`. [01](./01-concepts.md#the-hierarchy) |
| **Terminal** | A delivery state after which nothing more will happen: `succeeded`, `failed`, `exhausted`, `cancelled`. [05](./05-retries-and-delivery.md#the-delivery-state-machine) |
| **`Webhook-Signature`** | `t=<unix seconds>,v1=<hex>[,v1=<hex>]` - HMAC-SHA256 over `"<t>.<raw body>"`, one `v1` per active secret. [04](./04-receiving-webhooks.md#verifying-the-signature) |
