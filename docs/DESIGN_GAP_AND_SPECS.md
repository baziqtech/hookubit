# The design, against what is built

Read from `hookubit.pen` (28 screens) and checked against `apps/control-api/openapi.json`
and the dashboard source on 2026-09-21.

Three lists. **A** is design the current API already supports and our UI simply
does not expose — buildable with the redesign, no backend work. **B** is design
with no implementation behind it: each entry has a spec, to be built *after* the
UI is implemented and accepted. **C** is what the product does that the design
does not draw, which any redesign has to carry anyway.

The design's wordmark reads "Relay" throughout. The product is **HookuBit**.

---

## A. Buildable now — the API is already there

No backend work. These are places our UI is behind our own contract.

| Design | What exists | Note |
|---|---|---|
| API key **expiry** at creation | `CreateApiKeyDto.expires_at` | Our form collects a name only. |
| API key **scopes** at creation | `CreateApiKeyDto.scopes`, and `ApiKeyDto.effective_scopes` | The design lists `events:write`, `events:read`, `deliveries:replay`, `endpoints:write`. Ours derives scopes instead of offering them. |
| Key **expiry warning** ("expires in 6 days") | `ApiKeyDto.expires_at` | Pure presentation over a field we already return. |
| **Time-range filter** on lists | `created_after` / `created_before` on deliveries and events | Design shows Last 24 hours / 7d. We expose neither. |
| **Next retry countdown** ("in 2 minutes") | `DeliveryDto.next_attempt_at` | We show the timestamp; the design counts down. |
| **Subscription on a delivery** ("order.* → orders-service") | `DeliveryDto.subscription_id` | Needs a lookup, not a new route. |
| **Attempt count against the cap** ("attempt 3 of 5") | `attempt_count`, `max_attempts` | Already rendered, phrased differently. |
| **Per-endpoint failure ranking** | `GET …/analytics/endpoints` | Design's "Endpoint Health" minus its latency columns — see B4. |
| **Copy ID** affordances | — | Presentation only. |

---

## B. Not implemented — specs

Ordered by how much of the design depends on them. Each is written to be picked
up on its own, after the UI lands and is accepted.

### B1. Time-series analytics — blocks six charts

**Why.** Every chart in the design plots a value over time: *Delivery Health*
(deliveries per hour, 24h), *Success Rate* over time, *Events over time*,
*Latency percentiles* over time, *Delivery volume by endpoint*, *Top event
types*. The analytics API returns **aggregates only** — a window total and the
window before it. There is no bucketed route, so none of these charts can be
drawn from real data, and drawing them from anything else would be fabrication.

**Spec.** A bucketed series endpoint per existing analytics question:

```
GET /v1/projects/:projectId/analytics/series
    ?metric=deliveries|events|latency|success_rate
    &window_hours=1..720
    &bucket=minute|hour|day
```

Returns the echoed window, the bucket size actually used, and an array of
`{ bucket_start, ...values }` — never a sparse array: a bucket with no traffic
is a zero, not a gap, or every consumer redraws the x-axis wrong.

Constraints to honour:
- **Refuse, never clamp**, like the existing window parameter: a bucket size
  that would produce more than N points is a 400 naming the constraint, not a
  silently coarsened result. A clamped response carries numbers for a period
  the caller did not ask about.
- `success_rate` is `null` for a bucket where nothing settled — not `0`. Zero
  means everything failed.
- Latency per bucket inherits the existing sampling honesty: return
  `sample_size` and `exact` per bucket, or state the sampling once for the
  series and refuse to pretend otherwise.
- The query is a `date_trunc` group-by over `deliveries` / `events` /
  `delivery_attempts` — the three largest tables. It needs an index that covers
  `(project_id, created_at)` and a hard ceiling on bucket count, and it belongs
  behind the same per-IP throttle as the other analytics routes, at the
  *latency* budget rather than the cheap one.

**Until it exists:** no chart is drawn. The current Analytics page deliberately
shows aggregates and comparisons only, for exactly this reason.

### B2. Search — blocks four search fields and the command palette

**Why.** The design searches events "by event ID, type or payload", deliveries
"by delivery ID or endpoint", endpoints "by name or URL", and logs "by actor,
action or target". None of these exist. Events can be filtered by exact type and
by an idempotency-key substring; deliveries by status, endpoint, event type and
origin. There is no free-text search anywhere, and **payload search in
particular is a different kind of problem**: payloads are JSON, are offloaded to
object storage above 64 KiB, and are the largest thing the system stores.

**Spec, in two parts that should not be conflated.**

*B2a — prefix/identifier search.* Match on ID prefix and on endpoint or event
name. Cheap, index-backed, and covers most real use ("I have half a delivery
id from a log line"). Add `q=` to the existing list routes, matched against
indexed columns only, with the matched field named in the response so the UI can
say why a row matched.

*B2b — payload search.* Substantially harder and should be costed separately:
it needs either a GIN index over `jsonb` payloads (write amplification on the
hottest insert path in the product) or an external index. **Recommend
deferring** and saying so in the interface rather than shipping a search box
that silently only looks at metadata — a search that quietly does not search
where the user thinks it does is worse than no search box.

### B3. Live updates — blocks "Updated 4 seconds ago", "Stream logs", and the error screen

**Why.** The design shows a live delivery stream, its staleness, and a
disconnected state ("Live updates are paused — reconnecting to the delivery
stream"). Everything today is request/response with manual refresh.

**Spec.** Server-sent events per project, one stream, delivery and event state
transitions only:

```
GET /v1/projects/:projectId/stream   (text/event-stream)
```

- Authenticated by the session cookie like every other control-plane route, and
  **tenant-scoped at the connection**, not per message.
- A heartbeat comment at a fixed interval, so a proxy that buffers is
  detectable and the client can show the "reconnecting" state the design draws
  rather than looking merely quiet.
- Carries state *changes*, not rows: the client already holds the list and
  should patch it. A stream that pushes rows re-implements pagination badly.
- **Bounded fan-out.** One connection per tab per project, and the control
  plane must survive every operator in a customer leaving a tab open: this is a
  long-lived connection against a process that is otherwise stateless and
  horizontally scaled, so it needs either a shared bus or an explicit connection
  ceiling with a documented refusal.
- The client must degrade to the current polling behaviour when the stream is
  unavailable, not break.

### B4. Per-endpoint latency and health grade — blocks "Endpoint Health"

**Why.** The design's endpoint table shows success rate, average latency, p95,
and a grade of Healthy / Degraded / Failing. We return per-endpoint
`failed`/`total`/`failure_rate` and no latency at all. The grade does not exist
as a concept anywhere in the product.

**Spec.**
- Extend `GET …/analytics/endpoints` with `p50_ms`, `p95_ms` and `sample_size`
  per endpoint, computed the same bounded-sample way as the project-wide
  latency route, with the same `exact` honesty.
- **A grade is a product decision, not a computation.** Healthy / Degraded /
  Failing needs thresholds someone owns, and they must be stated in the
  interface — an endpoint labelled "Degraded" with no stated rule is a number
  dressed as a judgement. Recommend deriving it from the existing circuit
  breaker instead, which already has real thresholds and real meaning, rather
  than inventing a second health model that can disagree with it.

### B5. Test delivery — blocks "Send test event", "Send test", "Test all", "Test a pattern"

**Why.** Four buttons across the design. There is deliberately no test-delivery
route: the documented path is to publish a real event and watch it.

**Spec, if wanted.** `POST …/endpoints/:endpointId/test` sending a synthetic
event to one endpoint, and it must be **signed exactly like a real delivery and
recorded exactly like one** — a test that takes a different code path proves
nothing about the path that matters. It needs its own audit action, must be
rate-limited per endpoint (it is an outbound-request primitive exposed to any
authenticated user), and must be visibly marked in the delivery history so a
test can never be mistaken for production traffic. *"Test a pattern"* is
different and cheaper: a pure, stateless evaluation of a subscription pattern
against a sample event type, with no delivery involved.

### B6. Bulk replay — blocks "Replay selected" and "Replay all failed deliveries"

**Why.** The design offers multi-select replay on the deliveries list and a
"replay all failed" action in the palette. Replay today is one delivery or one
event at a time. A per-event fan-out replay is already capped at 50.

**Spec.** `POST …/deliveries/replay` taking an explicit list of delivery ids
(bounded, like the outbox requeue's batch of 100) rather than a filter.
**Do not implement "replay everything matching this filter."** Replay
manufactures outbound traffic against other people's servers; a filter-driven
bulk action means a mistyped filter is an outbound flood, and the blast radius
is invisible at the moment of clicking. An explicit id list keeps the count in
front of the person approving it.

### B7. API key rotation and IP allowlist

**Why.** The design shows "Rotate key" and an IP allowlist on creation. We have
create and revoke, and no allowlist.

**Spec.** Rotation is create-then-revoke with an overlap, exactly as endpoint
signing secrets already work — reuse that model rather than inventing a second
one. The allowlist is a CIDR list enforced at ingest, which means the *data
plane* must read it on the hot path: that is a per-request lookup on the
highest-volume path in the product, so it needs the same cached-with-bounded-
staleness treatment as rate-limit policies, not a database read per publish.

### B8. Billing

**Why.** The design draws a plan, a renewal date, invoices, a payment method and
a billing portal. There is no billing module: no plan, no invoice, no payment
method, no provider.

**Spec.** Out of scope for a UI pass. It is a product and a payment-provider
integration, not a screen. The page should stay an honest empty state until
that decision is made. `billing.read` / `billing.write` already exist in the
permission model, so the access story is settled whenever the feature is.

### B9. Federated sign-in (GitHub, SAML SSO)

**Why.** The design's sign-in offers both. Authentication is email and password
only.

**Spec.** Each is its own project. SAML in particular is an enterprise feature
with per-organization configuration, metadata exchange, and a just-in-time
provisioning decision about roles. Neither should be implied by a button until
it exists — a sign-in option that fails is worse than one that is absent.

### B10. Smaller gaps

| Design | Missing | Note |
|---|---|---|
| HTTP status filter (`HTTP: 5xx`) on deliveries | No status-code filter | Response codes live on attempts, not deliveries; needs a join or a denormalised last-status column. |
| "Add filter" builder | — | A generic filter UI over a fixed filter set; decide whether the flexibility is real. |
| "Cancel retries" on a failing delivery | No route to stop a retry chain | Distinct from pausing the endpoint, which cancels everything queued for it. |
| Endpoint detail page with tabs | No endpoint detail route | Ours is a list with dialogs. This is a UI decision, not a missing API — except the Logs tab, which needs B3. |
| "Download .env" after key creation | — | Client-side file generation; no backend. |
| Retention settings per project | Retention is deployment-wide env config | Making it per-project is a data-plane change, not a form. |
| Project health (Healthy/Degraded/Idle) on the project picker | No per-project health rollup | Same thresholds problem as B4. |
| Log source filter, "retained for 1 year" | Audit retention is not configurable or surfaced | Stating a retention we do not enforce would be false. |
| 15m / 1h / 6h windows | Minimum window is 1 hour | 1h and 6h are servable today; **15m is not** and must not be offered. |

---

## C. What the product does that the design does not draw

Any redesign has to carry these. They are real screens with real routes.

| | |
|---|---|
| **Stuck events** | Events accepted and never fanned out, why each stopped, and whether putting it back will help. Two of its five causes are futile to retry. Not in the design at all, and it is the recovery path for the failure mode the design never shows. |
| **Policies** | Retry policies and rate-limit policies per project, selectable per endpoint. The design shows "Delivery Settings" on an endpoint but no policy objects. |
| **Get started** | The six-step first-run checklist. The design has no onboarding state whatsoever — every screen is drawn full of data. |
| **Product tour** | Five steps, non-blocking, reopenable. |
| **Usage** | Per-project volume over a rolling window. |
| **The account flow** | Register, verify email, reset password, accept invitation. The design draws sign-in only. |
| **Outbox statuses beyond parked** | Queued, fanning out, fanned out — the "what is the router doing" view. |
| **Permission-refused states** | Controls disabled with the reason attached, across every role. The design shows one role with full access. |

---

## Sequencing

1. Implement the UI against **A** and **C** — everything with a real feature behind it.
2. Accept the UI.
3. Then **B**, in the order B1 → B2a → B3 → B4, which is roughly how much of the
   design each one unblocks. B5–B9 are independent product decisions.

Nothing in **B** should be drawn as though it works before it does. A button
that fails, a chart from invented numbers, or a search box that does not search
where it appears to is worse than a visible gap.
