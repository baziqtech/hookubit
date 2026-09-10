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

- Four tiles - success rate (24h), failed (24h), in retry, p95 latency.
- **Endpoints needing attention** - only the endpoints that are not
  delivering (auto-disabled first, then paused), each with the platform's
  reason. Healthy endpoints are not listed, so the one with an open circuit
  breaker is not buried under fifty merchant callbacks. "Every endpoint is
  delivering" when there are none.
- **Needs attention** - the most recent deliveries that exhausted every
  retry, linking to their detail pages and to the full exhausted list.

::: warning The four tiles do not yet read from the control API
The tiles on the Overview, and the whole Analytics page, are built against a
single analytics route that the control API does not serve. Against a real
installation the Overview's tiles show a load error while the two panels
beneath them work, and the Analytics page states plainly that it has no
control-API route. The control API *does* have analytics - four routes,
described next - but the dashboard has not been wired to them yet. Until it
is, read them through the [API reference](/api/).
:::

## Analytics

`/orgs/:orgId/projects/:projectId/analytics` shows the notice above against a
real installation. What the control API offers, all under
`/v1/projects/:projectId/analytics/` and all taking `window_hours` (1 to 720,
default 24):

| Route | Answers | Permission |
|---|---|---|
| `deliveries` | Every delivery status counted exactly over the window **and the window before it**, rolled up into succeeded / failing / exhausted / in flight / cancelled, with `success_rate` and the deltas. | `deliveries.read` |
| `endpoints` | Which endpoints are failing, ranked worst first by `failed + exhausted`, with the failure rate, the per-status split and the endpoint's current status. Read the rate beside the count: one endpoint at 100% of two deliveries is not the outage. | `deliveries.read` |
| `latency` | p50, p95 and p99 of attempt duration, nearest-rank over the most recent 200 measured attempts. `exact` says whether that sample was the whole window. | `deliveries.read` |
| `events` | Events published in the window and the busiest event types, beside the preceding window. Events and deliveries are expected to differ; their ratio is the fan-out. | `events.read` |

Three things to know before reading a response:

- **`success_rate` is null, never 0, when nothing settled.** Zero means
  everything failed. It is computed over settled deliveries only
  (`succeeded / (succeeded + failed + exhausted)`); in-flight ones are
  excluded.
- **The window is refused, never clamped.** Asking for more than 720 hours is
  a 400, so a number is never labelled with a longer period than it covers.
  The response echoes the exact window it used.
- **`by_status` always carries all nine statuses**, with 0 rather than an
  absent key.

Viewers can read all four; billing cannot. Every number is read from the
delivery ledger at request time, so it cannot disagree with the Deliveries
list. The routes are throttled (120 per five minutes; latency 60) because at
the 30-day ceiling they scan a large share of the ledger.

## Usage and billing

`/orgs/:orgId/usage` and `/orgs/:orgId/billing` are not built. Usage says so
on the page ("no control-API route"); Billing is an honest empty state
listing what is planned (plan and included volume, payment method, invoices,
overage alerts). There is no route behind either in the control API.

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
`apps/dashboard/src/features/overview/OverviewPage.tsx` (uses `useAnalytics`, mock-only),
`apps/dashboard/src/features/analytics/AnalyticsPage.tsx`, `apps/dashboard/src/features/usage/UsagePage.tsx`,
`apps/dashboard/src/features/settings/placeholders.tsx` (BillingPage),
`apps/dashboard/src/components/NoBackendRoute.tsx`, `apps/dashboard/src/features/projects/api.ts`
(`useAnalytics` docblock), `apps/dashboard/src/features/audit/AuditPage.tsx`, `api.ts`,
`apps/control-api/src/analytics/analytics.controller.ts`, `dto/analytics-response.dto.ts`,
`analytics-window.ts`, `analytics-limits.ts`,
`apps/control-api/src/audit/audit-logs.controller.ts`, `audit-logs.service.ts`,
`dto/audit-log-response.dto.ts`, `dto/list-audit-logs.query.dto.ts`,
`apps/control-api/src/authz/audit.service.ts` (`isCredentialKey`, `recordSystem`, `MAX_METADATA_DEPTH`).
