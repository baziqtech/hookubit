# Subscriptions

A subscription is the routing rule: it binds an endpoint to the event types it
should receive. Without one, events are accepted, stored, and delivered
nowhere. With several, one published event becomes one delivery per matching
subscription - the fan-out is materialised as rows, each with its own retry
chain.

## The list

`/orgs/:orgId/projects/:projectId/subscriptions` shows each subscription's
name (or "Unnamed"), the endpoint it routes to, its event-type patterns as
badges (`*` is highlighted, because it means everything), its payload filter
as JSON if it has one, and whether it is enabled or disabled.

::: info Not in the dashboard yet
The **New subscription** button does not open a form, and there are no edit,
enable/disable or delete controls on the rows. Manage subscriptions through
the API (`/v1/projects/:projectId/subscriptions`); the list reflects the
result. The rules below are the rules the API enforces.
:::

## Fields

| Field | Rules |
|---|---|
| `endpoint_id` | An endpoint in **this project**. Another project's endpoint is "Resource not found". A deleted endpoint is refused with a conflict: a subscription pointed at it could never deliver. |
| `name` | Optional, up to 200 characters. |
| `event_types` | 1 to 100 patterns, each up to 255 characters. See below. |
| `payload_filter` | Optional JSON predicate. See below. |
| `enabled` | Default `true`. |

## Event-type patterns

Exactly three forms are accepted, and they are exactly the three the router
implements:

| Pattern | Matches |
|---|---|
| `*` | Every event type. |
| `payment.*` | Every type beginning with the literal `payment.` - so `payment.settled` and `payment.card.captured`, but **not** `payments.settled` and **not** the bare `payment`. |
| `payment.settled` | That type, byte for byte. |

A type or prefix is dot-separated segments of letters, digits, `_` and `-`,
up to 8 segments.

**Anything else is refused when you save. Nothing is ever rewritten.** This
is the reason the platform exists: another product silently widened a
filtered subscription to `["*"]` when a licence flag was off, and finance
received payroll. Here a pattern is either honoured as written or refused,
never widened, never narrowed, never stored as something the router would
read differently. The refusals:

| You send | Why it is refused |
|---|---|
| `[]` | An empty filter matches **no** events, and the column default matches **all** of them. Either meaning is plausible, which is exactly why the platform will not guess. Use `["*"]` for everything, list the types you want, or set `enabled: false` to stop deliveries without touching the filter. |
| `["*", "payment.settled"]` | `*` already matches everything, so the row would read as filtered and receive everything. Send `["*"]` alone or drop it. |
| `pay*`, `*.settled`, `*.*` | A `*` outside the two sanctioned shapes. The router would treat `pay*` as an exact type and the subscription would never fire, silently. |
| `.*` | An empty prefix would match only types beginning with a literal dot. Write `*` if you mean everything. |
| `payment.settled ` (trailing space) | The router compares bytes; that type will never be published. |
| Duplicates | Refused rather than de-duplicated, so what is stored is what was sent. |

The response returns the stored array **verbatim**. What you read back is
what will match.

## Payload filters

A payload filter is a JSON predicate applied to the event body after the
event-type filter matched. It is validated and stored exactly as sent.

::: danger Payload filters are not evaluated yet
The delivery routers do not implement payload filters today. A subscription
with a filter behaves as if the filter were null and **receives every event
its event types match**. The language is nailed down now so that filters
written today mean the same thing when evaluation lands. Do not rely on a
payload filter to keep data away from an endpoint.
:::

The shape: an object whose keys are field paths or logical operators,
implicitly ANDed. A field path is dot-separated segments of letters, digits,
`_` and `-` (`data.amount` reads `payload.data.amount`). A condition is a
scalar (shorthand for `$eq`) or an object of comparison operators.

```json
{ "data.currency": "GHS", "data.amount": { "$gte": 1000 } }
```

| Operator | Operand | True when |
|---|---|---|
| `$eq`, `$ne` | scalar | strict JSON equality |
| `$gt`, `$gte`, `$lt`, `$lte` | number | both sides are numbers |
| `$in`, `$nin` | non-empty array of scalars | strict equality against a member |
| `$exists` | boolean | the path is present / absent |
| `$and`, `$or` | non-empty array of filters (up to 20) | combine filters |
| `$not` | one filter | negate |

Semantics the evaluator will implement exactly: strict typing with no
coercion (`"1000"` is not `1000`); an absent path satisfies only
`{"$exists": false}` - every other operator, `$ne` and `$nin` included, is
false against an absent field, so a producer dropping a field cannot widen a
filter into a leak; a type mismatch is false, not an error; ordering is
numeric only; arrays and objects satisfy only `$exists`; and a stored filter
the router cannot evaluate results in **no** delivery for that subscription,
never in "no filter".

Refused at save time: an empty object `{}` (it would match everything - omit
the field or send `null` for no filter), an empty `$in`/`$nin`, a path
beginning with `$`, `NaN`/`Infinity`, and anything over the bounds: 4096 bytes
serialised, 5 levels deep, 64 conditions, 8 path segments, 200-character
paths, 50 list values, 500-character strings.

## Enable and disable

A disabled subscription is skipped before the event-type test, so it matches
nothing at all. This - not an empty `event_types` - is how you stop
deliveries down one route without losing the filter. Enable and disable are
their own operations (not fields on an update) so that pausing a route is a
distinct, separately audited act; disable takes an optional reason (up to 200
characters) for the audit log. Both are idempotent. Deliveries already queued
when you disable are not discarded.

Nothing automatic disables a subscription; it has one flag and you are its
only writer.

## Updating

`event_types` and `payload_filter` are **replaced wholesale**, never merged.
Both sides of an event-type change are written to the audit log, because
"who widened this subscription, and when?" is the question that gets asked
after a leak. A subscription can be re-pointed at a different endpoint in the
same project.

## Deleting

Deleting a subscription really deletes the row (unlike endpoints and
projects). Nothing in the delivery ledger depends on it: a delivery keeps its
own `endpoint_id` and `event_id`, so "did finance ever receive this?" is
unaffected - only "which routing rule matched" is lost, and the whole rule
(endpoint, event types, payload filter, enabled) is written to the audit log
on the way out. A historical delivery whose subscription is gone shows a null
`subscription_id`. Deleting is idempotent.

## What a change means for events already accepted

Fan-out happens once, shortly after an event is accepted, and it is **pinned
to the subscriptions that existed at that moment**: a subscription created
after an event was accepted does not receive it, however wide the fan-out.
Once the delivery rows exist, the subscription that produced them can be
edited, disabled or deleted without touching them - each row already carries
its endpoint and its attempt budget.

Two consequences:

- **Replay** re-sends to the endpoints an event *actually reached*, read off
  its existing delivery rows. It never re-runs the subscription match against
  today's subscriptions. See [Events and deliveries](./07-events-and-deliveries.md#replay).
- **Requeueing a parked event** (one that never fanned out) runs the match
  the router never got to run, against the subscriptions that existed when
  the event was accepted, using their configuration *as of now* - so a
  subscription disabled or narrowed since applies, and one deleted since is
  gone. See [the Outbox](./07-events-and-deliveries.md#the-outbox-parked-events).

Two enabled subscriptions pointing at the same endpoint produce **one**
delivery for that endpoint, not two; the oldest subscription is the one
recorded on the row.

## Limits

A project may hold **500 subscriptions** by default (your installation's
operator can raise it). Because each subscription multiplies the deliveries
one event produces, this ceiling is enforced strictly rather than
approximately. Creation is rate limited to 30 a minute; updates, enables,
disables and deletes share a looser budget of 120 a minute, because those are
the operations reached for under pressure.

---

**Where this comes from** (for maintainers):
`apps/dashboard/src/features/subscriptions/SubscriptionsPage.tsx`,
`apps/dashboard/src/features/endpoints/api.ts` (`useSubscriptions`),
`apps/control-api/src/webhook-subscriptions/dto/create-subscription.dto.ts`,
`dto/update-subscription.dto.ts`, `event-type-pattern.ts`, `payload-filter.ts`,
`subscription-limits.ts`, `webhook-subscriptions.service.ts`,
`webhook-subscriptions.controller.ts`,
`services/data-plane/internal/router/match.go`, `plan.go` (`BuildPlan`, dedup, `gate`),
`services/data-plane/internal/router/plan.go` (`Event.CreatedAt` pins the subscription set),
`apps/control-api/src/outbox/outbox.service.ts` (requeue semantics).
