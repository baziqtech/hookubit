# Analytics, usage and audit

The read-only screens: the trend, the meter, and the record of who did what.

## Overview

`/orgs/:orgId/projects/:projectId/overview` is two different pages depending
on whether the project can deliver a webhook yet.

**Before setup is complete** it is the guided path: the setup checklist
inline, with a headline saying what to do next, and a link to Get started.
A project with no endpoints does not need a success-rate tile reading 0.00%.
See [Onboarding](./09-onboarding.md).

**Once setup is complete** it is the health page:

- **Five tiles**, read from two analytics routes over the API's default
  24-hour window and rendered as each response lands:

  | Tile | Field | Notes |
  |---|---|---|
  | Success rate (24h) | `analytics/deliveries` → `current.success_rate`, hint from `success_rate_delta` and `current.total` | Over settled deliveries only. **Null renders as "—" with "No delivery settled"**, never as 0%. The delta is in percentage points against the 24 hours before; null when either window had nothing settled. |
  | Failing (24h) | `current.failing`, hint from `by_status.failed` and `current.exhausted` | `failed + exhausted`. |
  | Exhausted (24h) | `current.exhausted` | Gave up; will not retry without a replay. |
  | In flight | `current.in_flight`, hint from `by_status.retrying` | Pending, scheduled, queued, processing, retrying — not an outcome yet. |
  | p95 latency (24h) | `analytics/latency` → `p95_ms`, hint from `exact`, `sample_size`, `sampled_deliveries` | Nearest-rank over a bounded sample. The hint says "Exact over N attempts across M deliveries" or "Most recent … — a sample, not the whole day". Null renders as "—". |

  A tile that fails to load shows its own error, code and `request_id` in
  place; the others stay up.
- **Endpoints needing attention** - only the endpoints that are not
  delivering (auto-disabled first, then paused), each with the platform's
  reason. Healthy endpoints are not listed, so the one with an open circuit
  breaker is not buried under fifty merchant callbacks. "Every endpoint is
  delivering" when there are none. This panel is about *state*.
- **Failing endpoints (24h)** - the worst five by `failed + exhausted` from
  `analytics/endpoints`, with the failure rate beside the count and the
  total it is a rate of. This panel is about *outcomes*: an endpoint can be
  on both lists (auto-disabled because it was failing) or on either alone.
  Each row links to the deliveries list filtered to that endpoint's
  failures.
- **Needs attention** - the most recent deliveries that exhausted every
  retry, linking to their detail pages and to the full exhausted list.

## Analytics

`/orgs/:orgId/projects/:projectId/analytics` reads the four analytics routes
under `/v1/projects/:projectId/analytics/`, one panel each, each landing on
its own. The window is a control in the page header and in the URL —
`?window=24h`, `7d` or `30d` (`window_hours` 24, 168, 720) — so a pasted link
opens on the same period. The default is the API's default, 24h.

**There is no time series.** The control API deliberately offers no hourly
buckets (see the service's own note on `date_trunc`); it answers "is it
getting worse?" by returning every count for the window *and* for the
immediately preceding window of equal length, with the delta. The page
compares rather than charts. The proportion bars are shares of counts the
response carries, and every bar has a table beside it with the numbers.

| Panel | Route | What is shown, and from which fields |
|---|---|---|
| Delivery outcomes | `deliveries` | Six tiles: success rate (`current.success_rate`, delta from `success_rate_delta`, previous rate alongside), deliveries created (`current.total`, `total_delta`, `previous.total`), succeeded, failing (`failing`, split into `by_status.failed` and `exhausted`), in flight (`in_flight`), cancelled. Then a bar and a table of **all nine statuses** — this window, previous window, change, share of `current.total` — each status linking to the deliveries list filtered to it. |
| Failing endpoints | `endpoints` (`limit=10`) | Ranked worst first. Endpoint name and URL (or "endpoint row missing" and the id when the row is gone), state now (`status`, with "paused by operator" when `enabled` is false and "auto-disabled" when `enabled` is true but `status` is `disabled`), failing (`failing`, split `failed`/`exhausted`), retrying, total, and `failure_rate`. The panel's own warning is repeated: read the rate beside the count. `has_more` renders as "more endpoints had failures than the 10 shown". |
| Attempt latency | `latency` | p50, p95, p99, min and max (`*_ms`, nullable, "—" when null). A badge reads **exact** or **sampled** from `exact`, with a sentence built from `sample_size` and `sampled_deliveries`: either "computed from every measured attempt in the window" or "a sample, not the whole window: the most recent N measured attempts … the window held more traffic than the sample cap". |
| Event volume | `events` (`limit=10`) | Events published (`total`, `total_delta`, `previous_total`), previous window, and **routing** = deliveries `current.total` ÷ events `total` — the one number on the page that combines two responses; it reads "—" with the reason while either is missing or when there were no events. Then a bar and a table of `by_type` (busiest first) with each type's share of `total`, linking to the events list. `has_more` renders as a note that the shares do not sum to 100%. |

Under every panel the exact window the API applied is printed from the
response's `window` (`from`, `to`, `previous_from`, `previous_to`, `hours`),
so a screenshot at 03:00 is still interpretable at 09:00.

Three things to know before reading a response:

- **`success_rate` is null, never 0, when nothing settled.** Zero means
  everything failed. It is computed over settled deliveries only
  (`succeeded / (succeeded + failed + exhausted)`); in-flight ones are
  excluded. The page renders null as "—" and words, never as a percentage.
- **The window is refused, never clamped.** Asking for more than 720 hours is
  a 400, so a number is never labelled with a longer period than it covers.
  The page only offers the three windows the API documents.
- **`by_status` always carries all nine statuses**, with 0 rather than an
  absent key, and the table always shows all nine rows.

Viewers can read all four; billing cannot. Every number is read from the
delivery ledger at request time, so it cannot disagree with the Deliveries
list. The routes are throttled (120 per five minutes per client; latency
60) because at the 30-day ceiling they scan a large share of the ledger;
the dashboard keeps each response for 30 seconds rather than refetching on
every focus, which is the cadence the controller budgets for.

## Usage and billing

`/orgs/:orgId/usage` is built from what exists, and says so on the page.
There is **no usage route and no billing period** on the control API. The
page lists the organization's projects (the first page of them — a note
says when there are more) with one row each:

| Column | Source |
|---|---|
| Events published | `analytics/events` at `window_hours=720`, `total` |
| Deliveries created | `analytics/deliveries` at `window_hours=720`, `current.total` |
| Routing | deliveries ÷ events; "—" when there were no events or either request has not landed |
| Window ends | the `window.to` the events response echoed |

Rows load independently; a row that fails shows the reason and `request_id`
in its cell rather than a zero. A totals row sums the rows above and appears
only once every project has loaded — a failed row leaves the totals unstated
rather than understated. Each project name links to its Analytics page on
the 30-day window.

The page states plainly that these are **rolling 30-day windows ending when
each row was fetched, not a calendar month and not anything an invoice is
calculated from**, and that each project costs two throttled requests (120
per five minutes per route).

`/orgs/:orgId/billing` is an honest empty state listing what is planned
(plan and included volume, payment method, invoices, overage alerts) and
pointing at Usage for the real numbers. There is no billing route in the
control API.

## The audit log

`/orgs/:orgId/audit` is the page that makes a delivery gap explainable.
"Why did finance stop receiving webhooks between 02:10 and 06:40?" is
answered by an `endpoint.disabled` entry plus the sentence the person typed,
and by nothing else.

### Who can read it

`audit.read` - **owner and admin only**. The rows carry other members'
actions, IP addresses and user agents, which is staff-surveillance data
rather than project data. A viewer, developer or billing member opening the
page sees "You cannot read this organization's audit log", naming the roles
that can and the role they hold. That is an ordinary state, not an error,
and there is nothing to retry.

### What a row carries

| Column | Meaning |
|---|---|
| Action | `<resource>.<verb>`, past tense: `endpoint.disabled`, `api_key.revoked`, `member.role_changed`, `subscription.updated`, `event_outbox.requeued`, ... Not a closed set; each part of the platform adds its own. |
| Resource | The type and id acted on (the id can be absent when the action had no single subject, such as an invitation). |
| Actor | `user` with a user id, `api_key` with a key id, or **`system`** ("platform") with neither - the circuit breaker auto-disabling an endpoint is the platform's own action and is recorded with no human's name on it. |
| Detail | The recorded metadata as JSON - what changed, often with before and after (`event_types_from`/`event_types_to`, `url_from`/`url_to`, `from`/`to` on a role change), the reason a person gave, and for platform actions the evidence and the remedy. Plus the source IP. |
| When | Relative, with the absolute time on hover. |

The actor is shown as an **id**, not a name or email; the row does not carry
one. Match it against the Team page.

Rows are written inside the transaction of the change they record, so a row
exists if and only if the change happened. There is no way to edit or delete
a row through the dashboard or the API; a correction is a new row.

### Credential redaction

Metadata is redacted **when it is written**, by key name: a value whose key
looks like a credential (`secret`, `password`, `token`, `authorization`,
`signature`, `api_key`, a bare `key`, and their relatives) is stored as
`[redacted]`, at every depth. Keys that are plainly metadata *about* a
credential - `key_prefix`, `secret_version`, `previous_secrets_expire_at`,
`endpoint_secret_id` - stay readable. Anything nested deeper than the redactor
walks is stored as `[truncated]`. Nothing on the read side ever reverses
either, and there is deliberately no search over metadata contents, because a
search would let a caller test candidate values against a redacted one.

### Filters

| Filter | Cost |
|---|---|
| Action (exact, e.g. `endpoint.disabled`) | Indexed. |
| Resource type (e.g. `endpoint`, `api_key`, `member`) | A scan within the organization and date range. |
| Resource ID | A scan. This is the "everything that ever happened to this endpoint" question. |

The API also accepts `user_id` (a scan) and a `created_after`/`created_before`
range (indexed; refused if inverted, because an empty page must never be the
accidental answer to "nothing happened"). The page reminds you to pair a
resource filter with a date range on a busy organization. Reads are throttled
(120 list calls per five minutes per address).

---

**Where this comes from** (for maintainers):
`apps/dashboard/src/features/overview/OverviewPage.tsx` (`Health`, `latencyCaveat`, `rankingColumns`),
`apps/dashboard/src/features/analytics/AnalyticsPage.tsx`, `api.ts` (the four hooks and `staleTime`),
`derive.ts` (`formatRate`, `deliveriesPerEvent`), `window.ts` (the three windows), `tiles.tsx`,
`apps/dashboard/src/features/usage/UsagePage.tsx`,
`apps/dashboard/src/features/settings/placeholders.tsx` (BillingPage),
`apps/dashboard/src/lib/mock/analytics.ts` (the mock's copy of the arithmetic),
`apps/dashboard/src/features/audit/AuditPage.tsx`, `api.ts`,
`apps/control-api/src/analytics/analytics.controller.ts`, `analytics.service.ts`,
`dto/analytics-response.dto.ts`, `dto/analytics-window.query.dto.ts`, `analytics-window.ts`,
`analytics-limits.ts`,
`apps/control-api/src/audit/audit-logs.controller.ts`, `audit-logs.service.ts`,
`dto/audit-log-response.dto.ts`, `dto/list-audit-logs.query.dto.ts`,
`apps/control-api/src/authz/audit.service.ts` (`isCredentialKey`, `recordSystem`, `MAX_METADATA_DEPTH`).
