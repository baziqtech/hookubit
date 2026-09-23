# CLAUDE.md

Context for building a webhook delivery platform — a Convoy-equivalent, owned in-house.

Nothing has been built yet. This file exists so a fresh session starts with the real
constraints rather than rediscovering them.

## Why this exists

ShaQ Express needed reliable webhook routing from a new payments gateway to two internal
consumers. We evaluated Convoy, stood a real instance up on the dev server, and hit
licence limits (below). The question of building an equivalent came out of that.

**The honest framing, which should survive into whatever gets built:** if the only driver
is avoiding a licence fee, the arithmetic usually favours paying it — you would be taking
on a product to save a subscription, and maintaining it forever. Build this if you need
something Convoy structurally cannot do, or if it is a product in its own right.

**The one real advantage available here:** requirements from a system already in
production, rather than guesses. Use them.

## FIRST DECISION — settle this before any code

**Internal routing, or multi-tenant?**

- _Internal_: a handful of known consumers, config-driven endpoints, one operator UI.
  Weeks of work.
- _Multi-tenant_: customer-facing portals, self-serve endpoint management, per-customer
  secrets and rate limits, an org/project hierarchy. Roughly ten times the first.

These are different products. Do not start until this is answered.

## What we already learned from running Convoy

Verified on the dev server (`ec2-54-226-22-32`, `/opt/convoy`, image `main-d2f6dfb`),
not recalled from documentation.

**Two planes, separable.** A control plane (REST API + UI; creates projects, endpoints,
subscriptions, ingests events) and a data plane (workers that make the outbound calls,
run retries, enforce rate limits). Scale the data plane for throughput; the control plane
can be down without stopping queued deliveries.

**Two stores, different jobs.** Postgres for durable state and the delivery ledger; Redis
as the _job queue_ — not a cache. Lose Redis and you lose in-flight deliveries. Any
equivalent must be explicit about which store is allowed to lose data.

**The data model** (real table names from the live schema):

```
organisations → projects → endpoints
subscriptions          bind an endpoint to what it should receive
sources, source_verifiers   inbound ingest (we deliberately did not use these)
events                 published once
event_deliveries       ONE ROW PER MATCHING SUBSCRIPTION — routing is materialised
delivery_attempts      per-attempt history
filters                subscription filtering (licence-gated)
token_bucket           per-endpoint rate limiting
portal_links           customer self-service
meta_events            Convoy's own events about delivery outcomes
```

The materialised routing is the important design choice: one published event becomes N
independent delivery rows, each with its own retry chain. That is what makes per-endpoint
replay possible and lets you answer "did finance ever receive this?".

**Community licence limits** (the reason this conversation happened):

- 1 org / 1 user / 2 projects
- `advanced_subscriptions` off → **event-type filters are silently discarded**. A
  subscription filtered to `["payment.settled"]` reads back as `["*"]`. Every
  subscription in a project receives every event.
- `credential_encryption` off → endpoint HMAC secrets stored in plaintext.

**Operational traps found in that build**, worth designing against:

- Ships a default credential (`superuser@default.com` / `default`) created silently on
  first start with an empty users table.
- `convoy bootstrap` segfaults on a nil licenser, leaving an orphan user and no org.

## What already exists to learn from

Read these before designing anything. Both are working implementations of the same idea
at different maturity levels.

**`shaq_payment_gateway` — `outbound_events` + the `http` driver.** The better reference.
A durable event row written _inside_ the state transition's transaction, dispatched
`afterCommit`, with a unique `(transaction, event_type)` index so one terminal transition
emits exactly one event, HMAC signing, and a `payments:redeliver-events` sweep for
stranded rows. This is the shape a minimal version should take.

**`shaq-express-api-v2` — `webhook_notification_queue` + `QueueWebhookNotificationJob`.**
The older pattern: a table swept on a schedule. Copy the shape, not the implementation —
it has no per-endpoint isolation and no circuit breaker, so one unresponsive partner URL
slows every other notification behind it.

## The hard part

The easy 80% — endpoints, subscriptions, routing, backoff, HMAC, a delivery log with
replay — is genuinely quick. These are where webhook systems actually live:

1. **Per-endpoint isolation.** One customer's 30-second timeouts must not starve everyone
   else. This is per-endpoint concurrency, not a shared worker pool.
2. **Circuit breaking and auto-disable**, then re-enabling without a thundering herd.
3. **Delivery at scale.** Materialised routing is cheap at 10 subscribers and expensive
   at 10,000.
4. **Secret rotation with overlapping validity**, so consumers roll without downtime.
5. **Ordered delivery**, if ever required — much harder than it sounds alongside retries.
6. **The operator surface.** The reason people pay for Convoy is not the retry loop; it is
   answering "what happened to this event" at 2am. If a human needs psql to answer that,
   the product is not finished.

## Principles carried over from the payments work

- **Payload is a JSON contract, never a serialised class.** Serialising framework objects
  welds producer and consumer repos together at the class name.
- **"If this component vanishes for an hour, do I lose data or only time?"** That question,
  not throughput, picks the transport and the storage guarantees.
- **The delivery record is written before the delivery is attempted**, so the table is the
  record of what _should_ be delivered. That is what makes replay possible.
- **Consumers must be idempotent**, because retries mean duplicate deliveries by design.

## Non-goals

- Inbound ingest / provider callbacks. In the payments design, the provider posts directly
  to the gateway; routing it through a webhook platform adds a hop on a path where a rider
  is waiting at a customer's door.
- Being a message broker. This delivers HTTP to endpoints that may be down.

## Conventions

Follow the sibling repos: PHP/Laravel with Pest, or state a deliberate reason to differ.
`shaq-express-api-v2` and `finance_api` are the closest stylistic references.

- Always ensure code-review agent goes through completed tasks
- use backend and frontend agents for related tasks and let them work concurrently
