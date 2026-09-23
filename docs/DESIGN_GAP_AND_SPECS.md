# The design, against what is built

Measured against `~/Documents/hookubit.pen` — **71 screens and 2 components**,
6.5 MB. (An earlier version of this document was written against a stale 3 MB
copy on the Desktop with 43 frames and a "Relay" wordmark. Do not read that file.)

**Status: most of it is built.** This document is now a record of what landed,
what was corrected along the way, and what is deliberately still open. The specs
for the remaining work are at the bottom.

---

## Built

### The brand, and the shell

- **Tokens and typeface.** Plus Jakarta Sans and violet `#6B38D4`, token for
  token from the design's "00 Brand" screen, replacing the Inter/indigo set that
  came from the stale file. Two rules from that screen are in `index.css` as a
  comment because they govern every screen drawn after: violet is for things you
  click and never for a state, and colour is never the only clue.
- **New token families**: seven `nav-*` (the rail owns its colour vocabulary),
  `sunken` (what a control sits *in*), `accent-deep` (accent text on a soft
  ground), `info-dot`.
- **The mark has its bit** — "a hook, and the single bit it has caught" — in the
  component and in the favicon, which is a separate document that can read
  neither. The wordmark sets `Bit` in the accent.
- **The rail is grouped**: Setup with a progress badge, then RECORD, ROUTING,
  INSIGHT, PROJECT, ORGANIZATION. This also fixed the reported bug where opening
  an org-level screen made the project items disappear.
- **Two switchers became one project card**, with the environment badge on it
  and in the breadcrumb.
- **Copy link to this view**, and a three-icon theme control, in the topbar.
- **Sixteen nav icons**, hand-drawn, distinct in shape because the tablet rail
  shows nothing else.

### Screens

| Design screen | Where it is |
|---|---|
| 01 Sign in | `AuthLayout` + `BrandPanel` — the panel's content is the product's own delivery record |
| 03 Setup checklist | `GetStartedPage`, now watching for the first event |
| 06–07b Overview | `OverviewPage` — window selector, chart, outcome split, stuck notice |
| 08–08b Deliveries | `DeliveriesPage` |
| 11–12 Events | `EventsPage` with the six-state rollup and the Deliveries column |
| 13–13b Stuck events | `OutboxPage`, with the futile count before a bulk requeue |
| 14 Endpoints | `EndpointsPage` — "Your setting" / "HookuBit", success rate, waiting, last delivery |
| 16 Endpoint detail | `EndpointDetailPage` — **new page** |
| 18 Subscriptions | matcher reference, and `stored, not yet applied` on conditions |
| 19 Policies | already had enforcement verdicts per rate-limit scope |
| 20–21 API keys | gained an Expires column |
| 22 Analytics | time-series chart plus the existing comparisons |
| 26 Project settings | gained the allowed-IP panel |
| 31 Responsive | icon rail at tablet, slide-out + bottom bar + row-cards on mobile |
| 32 Billing | `BillingPage` — real volume, honest about having no prices |
| 33 Notifications | `NotificationsPage` — email destinations |
| 01c–01e New project | templating, the production gate, the copy summary |

### Backend

- **`GET /analytics/deliveries/series`** — the window in wall-clock-aligned
  buckets. Unblocked every chart in the design.
- **`EventDto.deliveries`** — the six-way rollup, so the events list reports what
  became of the event rather than what became of the ingest.
- **`EndpointDto.health`** — success rate over a trailing hour, what is waiting,
  the breaker's counters, the last delivery.
- **`projects.allowed_ips`** — a publish allowlist, enforced in the Go ingest
  path before anything is said about the key.
- **`notification_destinations` / `notification_dispatches`** — per-project email
  alerting with confirmation, grouping and quiet hours.
- **`UsageAggregatorService`** — hourly rollups into `usage_records`, which
  nothing had ever written to.
- **`GET /organizations/:orgId/billing`** — metered volume for the month to date.
- **`copy_from_project_id`** — project templating.

---

## Corrections to the previous version of this document

Four things it got wrong, found by building them:

1. **Rate-limit enforcement verdicts were already built.** `RateLimitsTab` has an
   "Enforced today" column and a legend, and `enforcementVerdict` correctly
   identifies endpoint-scope policy rows as the inert ones — `ResolveDelivery`
   in the Go limiter is not wired to anything.
2. **The audit actor's source was already built.** The Actor column carries a
   `kind` badge that distinguishes a user from an API key from the system, which
   is the design's Source column and slightly better.
3. **`ErrorState` already surfaced `request_id`** and a per-code remedy. Only the
   status-page link from the design's screen 27 is missing, and there is no
   status page to link to.
4. **`GET /endpoints/:endpointId` already existed** (noted in the previous
   version, restated here because the endpoint detail page needed no API work).

And one correction to the B1 spec as written: the three drawn series are
`delivered_first_try`, `delivered_after_retry` and `failed`, which are
**disjoint**. The original spec had `delivered` and `retried` overlapping, which
would have doubled every bar.

---

## Bugs the tests found while building this

Recorded because each one was silent, and each is the kind that ships:

- **The series dropped deliveries whenever the clock was not on the hour.**
  Buckets were hung off the end of the window and counted from the span, so a
  24-hour window opened at 14:37 started its first bucket at 15:00 yesterday.
- **Both in-memory Prisma fakes ignored `take`/`skip` on `groupBy`**, so a caller
  that pages a grouped rollup and one that does not were indistinguishable —
  while against PostgreSQL the second is silently truncated at 200 groups.
- **Both fakes returned `_count: { _all: true }` as zero**, which reads as
  "nothing happened" rather than as a broken fake. The first event rollup
  appeared to work while reporting every event as `dropped`.
- **`FakeTenantPrisma` had no `_max`/`_min` at all**, so "last delivery" was
  `undefined` for every endpoint — a plausible answer and a wrong one.
- **The IP allowlist was checked after the key's validity**, leaving the oracle
  the feature exists to close. And it was handed the rate-limit bucket key, which
  widens IPv6 to a /64 — silently turning an entry naming one address into one
  permitting eighteen quintillion.
- **Project templating read the source through the target's scope**, which ANDs
  two different project ids and matches nothing: it produced an empty project and
  reported success.

---

## Still open

### Deliberately, by decision

- **Slack destinations.** Need an app, an OAuth install per workspace and a story
  for the app being removed. Email-only was the chosen scope.
- **Prices, invoices and payment.** A commercial decision, not an engineering
  one. The billing page states this rather than drawing an empty invoice table.
- **The marketing site** (design screens 35 Pricing, 36 Product, 38 Changelog).
  Assumes the pricing model above.

### Three of the four notification triggers are not raised

`endpoint.stopped` fires, from the auto-disable sweep. `event.stuck`,
`secret.retiring` and `delivery.exhausted` are subscribable and the page labels
them "not raised yet".

- `secret.retiring` is a control-plane sweep over `endpoint_secrets.expiresAt`
  and is the cheapest of the three.
- `event.stuck` and `delivery.exhausted` are noticed in the Go data plane. The
  control plane can poll for them — a parked outbox row, a newly `exhausted`
  delivery — which keeps notification logic in one language, as
  `endpoint-auto-disable.service.ts` argues for its own case.

### Per-endpoint p95

Not on the endpoints list, and the reason is in `EndpointHealthService`:
`delivery_attempts` carries no `endpoint_id`, so a per-endpoint percentile joins
through `deliveries`, and the project-wide version is already the dearest query
in the product. It belongs on the endpoint DETAIL page, bounded the way
`analytics/latency` bounds its own sample.

### The allowlist refusal panel

The design shows "We refused 203.0.113.9 four minutes ago · A valid key, from an
address that is not on this list." That needs a refusal log — a new table and a
write on a rejection path, which is a denial-of-service amplifier if done
naively. A bounded counter in Redis with a last-seen address would be the cheap
version.

### Smaller

| gap | where |
|---|---|
| `Matched (24h)` per subscription | needs a grouped count by `subscription_id` |
| `Used by` per retry policy | count of endpoints referencing it; one join |
| Columns picker | deliveries list; client-side |
| Account-verified column | team; `User` has verification, the member row does not carry it |
| Counts on the org/project pickers | project counts, member counts, 30-day event counts |
| Resend cooldown | verify email — "You can resend in 47s" |
| "What happened" diagnosis | delivery detail; rule-based over the attempt chain |
| `Retries stop at` / `Replays of this` | delivery detail; `maxRetryDurationMs` exists, the replay back-link does not |
| Docs IA | the design's fourteen doc pages map onto pages already in `apps/docs`; re-titling, not new writing |

---

## What the product does that the design does not draw

Build the design; do not let it delete these.

1. **Demo-data banner.** A seeded project that does not say it is seeded is a trap.
2. **`NoBackendRoute`.** The honest marker for a route with no API behind it.
   The design has the same idea with better words (screen 27's "NOT IN THE API").
3. **Ordering keys.** `Event.orderingKey` and per-delivery serialisation exist in
   the schema and in ARCHITECTURE.md §5. The design never mentions ordered
   delivery, and the UI has never exposed it either.
4. **Payload offload.** The design's payload panel assumes the bytes are always
   inline.
5. **`unaccounted_attempts`.** The design surfaces this well, as the `Pick-ups`
   column with its footnote. Keep both.
6. **`routing_cursor`.** The design's "Deliveries created: 2 of 3" is exactly this.
