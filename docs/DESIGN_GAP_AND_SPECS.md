# The design, against what is built

Read from `~/Documents/hookubit.pen` on 21 Sep 2026: **71 screens and 2 components**
(`Sidebar`, `Topbar`), 6.5 MB.

> An earlier version of this document was written against `~/Desktop/pen_designs/hookubit.pen`,
> which is a **stale 3 MB copy** — 43 frames, 28 screens, a "Relay" wordmark and an
> indigo palette. Everything it said about missing features was measured against the
> wrong file. This replaces it entirely. Do not read the Desktop copy again.

The redesign is much closer to the product than the old one was. It carries our name,
our nine delivery states, our five park reasons, our two-stage pipeline, and it keeps
Stuck events out of the navigation exactly as we decided. Most of what follows is
therefore detail, not disagreement — with four genuinely large exceptions
(§B6 notifications, §B7 project templating, §B8 billing, §B9 the marketing site).

**How to read this.** §0 is the brand change and has to land before any screen work.
§A is buildable today against APIs that already exist. §B is work that needs new
backend surface, one spec per item. §C is what the product does that the design does
not draw — build the UI, but do not delete these. §D sequences it.

---

## 0. Tokens and type — do this first

The design's variables are not the ones now in `apps/dashboard/src/index.css`. What I
applied yesterday came from the stale file and is wrong in both hue and typeface.

| token | in the repo now | in the design |
|---|---|---|
| sans | `Inter Variable` | **`Plus Jakarta Sans`** |
| mono | `JetBrains Mono Variable` | `JetBrains Mono` ✓ |
| accent, light | `#4C4DDC` | **`#6B38D4`** |
| accent, dark | `#7E7CF5` | **`#9267F2`** |
| canvas / `bg` | `#F6F7F9` | `#FAFAFC` |
| panel / `surface` | `#FFFFFF` | `#FFFFFF` ✓ |
| dark canvas | `#0B0D11` | `#0C0C0E` |

Tokens the design has that we do not: `surface-2`, `surface-3`, `accent-ink`,
`accent-soft`, `accent-border`, `info`, `info-soft`, `info-dot`, `focus`,
`violet-200`, and seven `nav-*` tokens (`nav-bg`, `nav-fg`, `nav-fg-muted`,
`nav-border`, `nav-hover`, `nav-active-bg`, `nav-section`).

The `nav-*` family is the interesting one: the rail is given its own colour vocabulary
rather than borrowing the page's, so the rail can be re-skinned without touching a
single page. Worth keeping.

The brand screen states one rule explicitly, and it is a good one:

> Violet is for things you click: buttons, links, focus rings, the active menu item.
> It never means a state.

Amber deliberately sits between green and red so the three settled outcomes do not read
as a yes/no pair. Every state is icon + word + colour, never colour alone.

**Action:** swap `index.css` and `tailwind.config.js`, add
`@fontsource-variable/plus-jakarta-sans`, drop the Inter package. One commit, no screen
changes. Everything downstream depends on it.

---

## A. Buildable now — the API is already there

Each of these is a UI change against data we already return.

1. **Nav sections.** The rail groups items under `RECORD` (Overview, Deliveries,
   Events), `ROUTING` (Endpoints, Subscriptions, Policies, API keys), `INSIGHT`
   (Analytics, Usage, Audit log), `PROJECT` (Project settings, Notifications),
   `ORGANIZATION` (Team, Billing, Organization settings). `Setup` sits above the first
   group with a `2/6` badge; `Product tour` and the user card sit in a footer.
   This also answers the question the user raised earlier — the org items no longer
   replace the project items on Settings, they are a section of the same rail.

2. **Project switcher card** in the rail: project name, env badge
   (`PRODUCTION`/`TEST`), org name underneath. We have all three.

3. **Theme control** moves into the topbar as a three-segment control
   (system / light / dark). `useThemeStore` already has all three preferences;
   `ThemeToggle` just changes shape.

4. **"Copy link to this view"** in the topbar. Every route is already fully
   addressable — this is `navigator.clipboard.writeText(location.href)`.

5. **Subscriptions: the matcher explainer.** Three accepted forms (`*`, `payment.*`,
   `payment.settled`) with one line each. Static copy; `event_types` already works this way.

6. **Subscriptions: `STORED, NOT YET APPLIED`** on the condition column. The design is
   telling the truth about us — `payload_filter` is written by the control API and the
   Go router never reads it. Render the badge, keep the panel note.

7. **Policies: "Stored, not enforced yet"** per rate-limit row. Same honesty:
   `RateLimitScope` has four values and only some are enforced today. Mark each row
   with what is actually applied.

8. **API keys: expiry and last-used columns**, and *revoked outranks expired* in the
   state column. `expiresAt`, `lastUsedAt` and `revokedAt` are all on `ApiKey`.

9. **Endpoints: two columns, not one.** "Your setting" (`enabled`) and "HookuBit"
   (`status` + `disabled_reason`) side by side. This is the single best idea in the
   endpoint design — *an endpoint you still want running that we stopped is a different
   problem from one you paused yourself, and they are fixed differently*. Both fields
   are already on the wire.

10. **Audit log: a Source column.** `Dashboard` when `userId` is set, `System` when
    neither actor is. Derivable from the row we already return.

11. **Requeue reason becomes required.** `RequeueOutboxDto.reason` is optional today;
    the design's confirm dialog makes it mandatory and says where it goes ("Recorded
    against each event in the audit log, with your name and the time"). One DTO change
    plus the dialog.

12. **The futile warning in the requeue dialog.** We already classify every parked row
    with an outlook (safe / caution / futile). The design surfaces the count before the
    action: *"1 of these will park again for the same reason — putting it back changes
    nothing."* Pure client-side arithmetic over rows we have.

13. **Disabled-with-reason everywhere.** `GatedButton` exists; the design applies the
    pattern harder and states the principle: *buttons you cannot use are shown with the
    reason, not hidden — if they vanished you would not know the feature exists, or who
    to ask.* Audit our disabled states against that.

14. **Sign-in art direction.** The tagline *"A call that is never lost"*, a brand panel
    with a three-row static delivery sample, and the line *one event published · one
    delivery per matching subscription · each retries on its own*. Static markup.
    The brand screen also says the tagline is for outward-facing surfaces only and must
    never appear inside the product shell.

15. **The five kinds of nothing.** We have `EmptyState`, `ErrorState`, `Placeholder`,
    `NoBackendRoute`, `Skeleton` — the design names the same five and adds a support
    reference plus a status-page link to the failure case.

---

## B. Not implemented — specs

### B1. Time-series analytics — blocks every chart in the file

**Blocks:** Overview "Delivery outcomes" (hourly stacked bars, 24 buckets),
Analytics "Delivery outcomes" (daily stacked bars, 7 buckets, with per-series deltas
against the preceding period), and the Overview window selector (1h / 24h / 7d / 30d)
in any form that redraws a chart.

**Why it is blocked.** `GET /projects/:id/analytics/deliveries` returns *totals for a
window plus totals for the preceding window*. There are no buckets. Every bar in the
design needs a series.

**Spec.**

```
GET /projects/:projectId/analytics/deliveries/series
    ?window=1h|24h|7d|30d
    &bucket=minute|hour|day        // defaulted from window, validated against it

200 {
  "bucket": "hour",
  "buckets": [
    { "start": "2026-09-21T13:00:00Z",
      "delivered": 1984, "retried": 41, "failed": 12, "in_flight": 3 },
    ...
  ],
  "truncated": false
}
```

- Bucket counts are capped (24 for `hour`, 30 for `day`, 60 for `minute`); a window
  that would exceed the cap is rejected rather than silently downsampled.
- `delivered` is `succeeded`. `retried` is a delivery that settled successfully *after*
  more than one attempt — it is a property of the attempt chain, not a status, so it
  needs `attempts > 1 AND status = succeeded`. `failed` is `failed + exhausted`.
  `in_flight` is everything else.
- Bucket on `Delivery.completedAt` where it exists, falling back to `createdAt`, and
  say which in the response — otherwise a chart of a slow window moves under you.
- The same shape serves both charts. Only `bucket` differs.

**Cost.** One grouped scan per request over `deliveries` in the window. Needs an index
on `(project_id, completed_at)`; we have `(project_id, created_at)` only.

**Until it exists.** Render the Overview and Analytics panels with the legend, the
titles and the numeric summaries, and put the *"This screen isn't built yet"* card
(design screen 27) where the plot goes. The design already supplies that card and its
words. Do not draw a fake chart.

---

### B2. Event delivery rollup — blocks the Events list as drawn

**Blocks:** the Events table's `Status` column (six states) and its `Deliveries` column
(`"3 of 3 delivered"`, `"1 delivered · 1 retrying · 1 failed"`, `"No subscription
matched — nothing was created"`, `"Creating deliveries…"`), plus the Event detail
"Deliveries created" panel's per-row match string.

**Why it is blocked.** `Event.status` is the *ingest/fan-out* state and has four values
(`received`, `processing`, `processed`, `failed`). The design's six are a rollup of the
event's **deliveries**, which the list never joins to. `EventsPage` already carries a
comment saying the event's own status is all the list can honestly report — that
comment is correct and this spec is what changes it.

**Spec.** Extend the list row:

```
"delivery_rollup": {
  "state": "received" | "in_progress" | "delivered" | "partly_delivered"
         | "all_failed" | "dropped",
  "total": 3, "succeeded": 1, "failed": 1, "in_flight": 1, "cancelled": 0
}
```

- `dropped` is the important one and the one newcomers hit: fan-out **completed** and
  produced zero deliveries because no subscription matched. It is
  `status = processed AND total = 0` — distinct from `received`, where fan-out has not
  run yet, and from a stuck event, which has no completed fan-out at all.
- `partly_delivered` requires at least one settled success and at least one settled
  failure; while anything is still moving the event is `in_progress`.

**Cost.** A grouped aggregate over `deliveries` keyed by the page's event ids — one
extra query per page, not per row. Needs `(event_id, status)`; we index
`deliveries(event_id)` already, so this is a widening, not a new index.

---

### B3. Endpoint detail page — blocks design screens 16, 17 and 28

**Blocks:** the entire endpoint detail surface. Today endpoints are a table plus
dialogs — there is no detail *page* in the dashboard, though the API behind one is
already there. The design gives it configuration, custom headers, recent deliveries,
signing secrets with overlap state, and a delete panel — and screen 28 uses that same
page to demonstrate the permission-refused pattern.

**What already exists.** `Endpoint` carries `timeoutMs`, `maxConcurrency`, `rateLimit`,
`rateLimitWindowSeconds`, `retryPolicyId`, `customHeaders`. `EndpointSecret` carries
`version`, `active`, `expiresAt`, `rotatedAt` — the overlap window in the design
("both signatures until 22 Sep 14:12 UTC") is exactly what `expiresAt` means.
`EndpointHealth` carries `consecutiveFailures`, `openedAt`, `state`.

**What is missing.**

1. The route and the page. `GET /projects/:projectId/endpoints/:endpointId` already
   exists and returns the row — so this is dashboard work, not API work.
2. `follow_redirects` on `Endpoint`. The design shows it as a configuration row
   (`No`). We have no such column and the Go sender does not follow redirects, so the
   honest move is to add the column defaulting to `false` and render it read-only until
   the data plane honours it — or to drop the row from the design. **Decide this one.**
3. Success rate (1h) and P95 per endpoint, for the header and the list — see B4.
4. `Recent deliveries` is just the deliveries list filtered by `endpoint_id`, which we
   already support. No new API.

**The secrets panel is the part worth building carefully.** The design distinguishes
three secret states — `Active`, `Overlapping` (with "Retires in 22h"), `Retired` —
and disables `Retire` on the last active one with the reason spelled out: *"This is the
last active secret — retiring it would make every delivery fail."* That guard belongs
in the API, not only in the button.

---

### B4. Per-endpoint success rate and latency — blocks two columns and a panel

**Blocks:** `Success (1h)` and `P95` on the endpoints list, the "Endpoint health" panel
on the delivery detail (`Success rate (1h)`, `Deliveries waiting`), and the
`Consecutive failures` / `Opened` readings beside them.

**Why it is blocked.** `analytics/endpoints` ranks endpoints by failures over a window
but returns neither a per-endpoint latency percentile nor a 1-hour rate;
`analytics/latency` returns project-wide percentiles from a bounded sample.
`EndpointsPage` already documents that there is no `success_rate_24h` on the wire.

**Spec.** Add to the endpoint list row, computed over a fixed trailing hour:

```
"health": {
  "success_rate_1h": 0.9998 | null,      // null, never 0, when nothing settled
  "p95_ms": 164 | null,
  "consecutive_failures": 14,
  "opened_at": "2026-09-21T14:08:00Z" | null,
  "deliveries_waiting": 37,
  "last_delivery_at": "2026-09-21T14:14:52Z" | null
}
```

`null` and `0%` must stay distinct — the design makes this point twice, once on the
endpoints list and once in Analytics: *"new-consumer had no deliveries in this window,
so its failure rate is unknown, not 0%. Zero would mean everything worked."*

**Cost.** This is a per-row aggregate on a list page, which is the shape that gets
expensive. Compute it for the page's endpoint ids in one grouped query, cache for
30–60s, and say in the panel when it was computed.

---

### B5. Live setup progress — blocks the checklist's last step

**Blocks:** *"Watching for your first event — this page updates the moment one
arrives. 0 events received"* on the setup checklist, and `Checked a few seconds ago` on
the Stuck events empty state.

**Spec.** Do **not** build SSE for this. Poll `GET /projects/:id/events?limit=1` every
3s while step 6 is the active step and the page is visible, stop on the first row, and
show the timestamp of the last check. The design's claim is "updates the moment one
arrives"; a 3s poll satisfies a human reading a checklist and costs one indexed query.
Revisit only if a live delivery feed is ever wanted, which the design does not draw.

---

### B6. Notifications — entirely unbuilt (design screens 33, 33a, 33b)

**Blocks:** a whole navigation item.

Our `notifications` module is transactional mail — verification, invitations, password
resets. The design's Notifications is **operational alerting, per project**: Slack
channels and email addresses as destinations, a catalogue of what triggers a message,
quiet hours, grouping, and a test send.

**Spec.**

```
model NotificationDestination {
  id, projectId, kind: slack | email,
  target,                    // channel id, or address
  label,                     // "#payments-alerts", "oncall@northwind.io"
  status: pending | connected | revoked | bouncing,
  subscribedEvents: String[],
  confirmedAt, lastSentAt, lastError, createdAt, updatedAt
}
```

Triggers the design names, and which of them we can already detect:

| trigger | detectable today |
|---|---|
| An endpoint was stopped by us | yes — breaker transition to `open` |
| An event got stuck | yes — outbox row reaching a park reason |
| A signing secret is about to retire | yes — `EndpointSecret.expiresAt` |
| A delivery gave up | yes — `exhausted` |
| Daily summary | yes — from analytics totals |
| Someone changed a subscription or a policy | yes — audit log; off by default |

Rules the design states and that belong in the sender, not the UI:

- Repeats grouped: the same endpoint failing again within 30 minutes updates the first
  message instead of sending a second.
- Nothing between 22:00 and 07:00 **except** an endpoint being stopped.
- Email destinations are confirmed before they receive anything; unconfirmed addresses
  sit in the list as `Not confirmed` and get nothing. Confirmation link lasts 7 days.
- A test send uses a made-up endpoint so nothing in the record changes.
- Destinations are **per project**, and the screen says so at the top — connecting
  Slack for Payments does not connect it for Ledger.

The Slack side needs an app, an OAuth install per workspace, `chat:write` only, and
graceful handling of removal (the design shows a `Slack removed us` row with a
Reconnect action). That is the largest single piece of work in this document.

**Recommendation.** Ship email destinations first. They reuse the mailer we already
have, cover the two triggers that actually wake someone (endpoint stopped, event
stuck), and need no third-party app review. Slack second.

---

### B7. Project templating and the production gate — design screens 01c, 01d, 01e

**Blocks:** the New project dialog and the Project created screen.

Creating a project works today. What is unbuilt:

1. **Start from an existing project.** Copy endpoints (with timeouts and limits),
   subscriptions, retry policies and custom headers. **Never** copy signing secrets,
   API keys, the delivery record or notification destinations — the design states this
   as a rule and gives the reason: *a leak in one project stays in one project.*
2. **Copied endpoints arrive paused and without secrets**, so a copied URL can never
   reach the wrong server before a human has looked at it.
3. **The production gate.** Selecting `Production` reveals three consequences:
   events become billable immediately; nothing sends until each endpoint has a signing
   secret; the allowed-IP list starts empty so any valid key can publish. Selecting a
   *test* source for a *production* project adds a fourth warning about test URLs.
4. **The created screen** — counts of what came across, a three-item "before anything
   is delivered" list, the publish URL, and *"Nothing is billable until this project
   accepts its first event."*

Note the environment vocabulary: the design says `PRODUCTION`, the schema enum says
`live`. Map at the edge; do not migrate the enum.

---

### B8. Billing and invoices — design screens 32 and 34

**Blocks:** a navigation item that is a placeholder today
(`features/settings/placeholders`).

We have `Plan`, `BillingSubscription` and `UsageRecord`. We have no invoice, no payment
method, no line items and no provider integration. The design draws: plan card, current
period estimate, a four-line overage table (events accepted, delivery attempts,
replays, payload history, people with access), invoice history with downloads, a plan
panel, card and billing-contact panels, and a rendered PDF invoice.

It also draws an access rule worth keeping: *only Owners and Billing admins can open
this page* — which matches the `billing` value already in `MemberRole`.

**Recommendation.** This is a commercial decision, not a design one. Until a provider
is chosen, leave the placeholder and let it say so in the design's own words:
*"This screen isn't built yet."*

---

### B9. The marketing site — design screens 35, 36, 37 (+14), 38

**Blocks:** four public surfaces that do not exist in this repo at all: Pricing,
Product, Docs and Changelog, sharing a nav and a footer.

`apps/docs` is a VitePress site with 50+ pages, which covers the *content* of the
design's Docs section but not its shell (three-column layout, search, "On this page",
a "Was this helpful?" footer). The design's docs IA is narrower and better organised
than ours:

- **Getting started:** Quickstart, Send your first event, Verify a signature, Go to production
- **Core ideas:** Events, Deliveries, Subscriptions, Retry policies, Stuck events
- **Reference:** Sending events, Webhook headers, Error codes, Rate limits, Event details, Delivery details

Every one of those maps onto a page we already have under `apps/docs/guide/` or
`apps/docs/api/`. **Adopting the design's IA is a re-titling and re-nesting job, not new
writing** — and it is worth doing, because "Stuck events" as a first-class concept page
is something our docs lack.

Pricing, Product and Changelog are new. They also assume a commercial model
(Free / Starter / Growth / Enterprise) that §B8 has not settled.

---

### B10. Responsive — design screen 31

**Blocks:** anything below 1024px. The dashboard is desktop-only today.

- **Tablet (834px):** the rail collapses to a 56px icon-only column; tables keep every
  column.
- **Mobile (390px):** slide-out nav, table rows become stacked cards, and a five-item
  bottom navigation (Overview, Deliveries, Events, Endpoints, More).

The row-to-card transform is the real work and it belongs in `Table.tsx` once, driven
by the column definitions, not re-authored per page.

---

### B11. Smaller gaps

| gap | where | note |
|---|---|---|
| Support reference (`req_…`) | delivery detail, event detail, error states | We have request ids in tracing; surface one per response. |
| `Retries stop at` / `Replays of this` | delivery detail | `maxRetryDurationMs` exists; the replay back-link does not. |
| "What happened" diagnosis | delivery detail (screen 10) | A written explanation of the failure shape. Can be rule-based over the attempt chain — same status every time and connections accepted ⇒ fault at their end. |
| Deliveries filters: `Origin`, `Failing right now`, `Replays only` | deliveries list | `Origin` needs a replay/original flag on the row. |
| `Columns` picker | deliveries list | Client-side. |
| `Matched (24h)` per subscription | subscriptions list | Needs a grouped count by `subscription_id`. |
| `Used by` per retry policy | policies list | Count of endpoints referencing it. One join. |
| Allowed IP addresses | project settings | No column on `Project`. The design's rule — *the list is checked before the key, so a refused address never learns whether the key was valid* — is the part to get right. Publishing only; never the dashboard, so nobody can lock themselves out. |
| Account-verified column | team | `User` has verification; not on the member row. |
| Org/project counts on the pickers | choose org, choose project | Project counts, member counts, 30-day event counts, "last opened by you". |
| Resend cooldown | verify email | *"You can resend in 47s"*. |

---

## C. What the product does that the design does not draw

Build the design; do not let it delete these.

1. **Demo-data banner** (`DemoDataBanner`). Nothing in the design shows it, and it must
   survive — a seeded project that does not say it is seeded is a trap.
2. **`NoBackendRoute`.** Our honest marker for a route with no API behind it. The design
   has an equivalent idea (screen 27's *"NOT IN THE API"* card) with better words —
   adopt the words, keep the component.
3. **Ordering keys.** `Event.orderingKey` and per-delivery serialisation exist in the
   schema and in ARCHITECTURE.md §5. The design never mentions ordered delivery.
   Not a gap in the design — a reminder that the UI has never exposed it either.
4. **Payload offload** (`payloadLocation`, S3 beyond `PAYLOAD_INLINE_MAX_BYTES`).
   The design's payload panel assumes the bytes are always there.
5. **`unaccounted_attempts`** — the poison bound that separates "the router crashed on
   this" from "the router understood it and failed". The design *does* surface this,
   beautifully, as the `Pick-ups` column ("all 11 left no result" / "all 63 recorded a
   reason") with a footnote explaining it. Keep both the column and the footnote.
6. **`fan_out_cursor`** — resumable partial fan-out. The design's `Deliveries created:
   2 of 3` column is exactly this and is the right way to show it.

---

## D. Sequencing

1. **§0 tokens and type.** One commit. Everything else is drawn on top of it.
2. **§A, all fifteen.** No backend work. This is most of the visible redesign —
   nav sections, the endpoint intent/platform split, the theme control, the honesty
   badges, the required requeue reason.
3. **B3 endpoint detail.** The largest missing *page*, and it needs no new API —
   the read already exists. It unlocks screens 16, 17 and 28 together.
4. **B2 event rollup**, then **B4 endpoint health**. Both are page-level aggregates
   over tables we already index; both remove a column the design draws and we cannot
   fill.
5. **B1 time-series.** Do this before drawing any chart. Until then, the
   *"isn't built yet"* card goes where the plot does.
6. **B5 polling**, **B11 smaller gaps** — opportunistic, alongside the above.
7. **B6 notifications, email only.** The first genuinely new subsystem.
8. **B10 responsive.**
9. **B7 templating**, **B6 Slack**, **B9 docs re-IA.**
10. **B8 billing**, **B9 pricing/product/changelog** — blocked on a commercial decision,
    not on engineering.

**The open question from last time still stands and is now sharper:** B1 blocks four
charts across two screens. Either build the series endpoint before the Overview and
Analytics redesigns, or ship those two screens with the design's own
*"This screen isn't built yet"* card where the plots go. The design supplies that card
precisely so we do not have to invent a way to say it — which is an argument for
shipping the screens first.
