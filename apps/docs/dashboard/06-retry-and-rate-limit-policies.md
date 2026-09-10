# Retry and rate-limit policies

Two kinds of policy live at project level. A **retry policy** is the backoff
curve the delivery workers run for an endpoint; a **rate-limit policy** is a
ceiling on how fast deliveries go out, or events come in.

::: info What the dashboard has today
- The endpoint form has a **Retry policy** picker over the policies this
  project owns, with each option described in words ("8 attempts, exponential
  ×2 from 5s up to 1h"). There is no screen for creating or editing a policy;
  the picker says so and names the API route when the project has none.
- There is no rate-limit screen at all. Project settings lists both editors
  under "Not built yet".

Everything below is therefore the API's behaviour, as reflected in what the
dashboard shows.
:::

## Retry policies

`/v1/projects/:projectId/retry-policies` - read with `policies.read` (every
role except billing), write with `policies.write` (owner, admin, developer).

### Fields

| Field | Range | Default | Meaning |
|---|---|---|---|
| `name` | 1 to 200 characters | - | |
| `strategy` | `exponential`, `linear`, `constant` | `exponential` | `exponential` multiplies the previous delay by `multiplier`; `linear` adds `initial_delay_ms` each time; `constant` repeats `initial_delay_ms`. |
| `max_attempts` | 1 to 50 | 8 | Total attempts **including the first delivery**. |
| `initial_delay_ms` | 1 to 86 400 000 (1 day) | 5 000 | Delay before the first retry. |
| `max_delay_ms` | 1 to 86 400 000 | 3 600 000 (1 hour) | Ceiling on any computed delay. |
| `multiplier` | 1 to 100 | 2 | Read by `exponential` only. |
| `jitter_ratio` | 0 to 1 | 0.2 | Symmetric jitter as a fraction of the computed delay, so a thousand deliveries to one recovering endpoint do not stampede in lockstep. |
| `max_retry_duration_ms` | 1 000 to 604 800 000 (7 days) | 86 400 000 (24 hours) | Wall-clock budget from the first attempt. A delivery that only ever gets *deferred* (open breaker, rate limit) still spends this. |
| `is_default` | boolean | see below | |

The bounds are not cosmetic. Every one of them is a value the delivery
workers can turn into a positive, finite delay; a `max_delay_ms` of 0 once
overflowed the computed delay and scheduled retries permanently in the past.

Three cross-field rules are checked on the **merged** settings, so an update
cannot walk a policy into an incoherent combination one field at a time:

- `initial_delay_ms` must not exceed `max_delay_ms` - otherwise every retry is
  clamped to the ceiling and the strategy does nothing.
- With more than one attempt, `max_retry_duration_ms` must be at least
  `initial_delay_ms` - otherwise the budget expires before the first retry is
  due.
- With `strategy: exponential`, `multiplier` must be **greater than 1**. The
  workers substitute 2 for any multiplier of 1 or less, so a stored 1 would
  not describe what happens. Use `constant` for a flat delay.

### The project default

Every project with any retry policies has **exactly one default**:

- The first policy created in a project becomes the default whether or not
  it asked to.
- `POST .../retry-policies/:policyId/default` makes a different one the
  default and clears the previous one in the same transaction. `is_default`
  is not accepted on an update for that reason.
- Deleting the default while other policies exist requires naming the
  successor (`?replacement_id=`) in the same request, so the project is
  never observed with policies and no default. Deleting the last policy is
  allowed; the project falls back to the built-in default.

### Which policy a delivery uses

Resolved at fan-out time and **stamped onto the delivery row** as
`max_attempts`, so editing a policy mid-incident does not change the budget of
deliveries already created:

1. The endpoint's own policy, if one is attached.
2. Otherwise the project default.
3. Otherwise the built-in default: 8 attempts, exponential ×2 from 5 seconds
   up to 1 hour, jitter 0.2, 24-hour budget.

What is retried at all is not a policy setting: network-level failures, and
HTTP 408, 429 and 5xx, are retried; every other 4xx is permanent and ends the
chain. See [Retries and delivery](/guide/05-retries-and-delivery).

### Deleting a retry policy

A policy referenced by any **live** endpoint cannot be deleted; the refusal
says how many. Deleting it would silently move those endpoints onto the
built-in default with nothing in the record to say so. Re-point them first.
Deleted endpoints that still reference the policy do not block deletion; they
are unlinked and the count is recorded in the audit entry.

Retry policies are hard-deleted: nothing in the delivery ledger references
one.

A project may hold 50 retry policies. Writes are rate limited to 60 per five
minutes per address.

## Rate-limit policies

`/v1/projects/:projectId/rate-limits` - same permissions as retry policies.

### Scopes

A policy has a `scope` and, optionally, a `resource_id`:

| Scope | Bounds | `resource_id` names | Null `resource_id` means |
|---|---|---|---|
| `endpoint` | outbound delivery to one endpoint | an endpoint in this project | every endpoint in the project |
| `project` | outbound delivery across the project | this project's own id (nothing else is accepted) | the project |
| `organization` | outbound delivery across every project in the organization | this organization's id | the organization |
| `ingest` | events accepted by the ingest API | an **API key** in this project | every key in the project, as one shared budget |

One policy per `(scope, resource_id)`, and the null-resource row counts:
two "every endpoint in this project" policies would give the platform two
answers to one question, so the second is refused as a conflict. A
`resource_id` from another tenant is "Resource not found".

### Fields

| Field | Range | Default | Meaning |
|---|---|---|---|
| `limit` | 1 to 10 000 000 | - | Requests allowed per window. Never 0: that would switch delivery or ingestion off for whatever the policy covers. |
| `window_seconds` | 1 to 86 400 | 1 | The refill rate is `limit / window`. |
| `burst` | `limit` to 10 000 000, or null | null (same as `limit`) | Bucket capacity. Must be at least `limit`, or the configured limit could never actually be reached. |

Changing `scope` or `resource_id` re-identifies the row: the new resource is
resolved and uniqueness re-checked. Changing scope while a `resource_id` is
set requires re-stating the resource (or null), because an endpoint id means
nothing at organization scope.

### How policies combine

Two rules, and the second is the one people get wrong:

- **Within one scope, the most specific row wins.** A policy naming this
  endpoint beats the every-endpoint policy; never both.
- **Across scopes, every applicable bucket is charged**, and any one may
  refuse. They are **nested budgets, not fallbacks**: an endpoint limit of
  100/s inside a project limit of 500/s means both, and the tightest bites
  first. A per-key policy can never *raise* a request above its project's
  ceiling.

The order in which buckets are charged:

| Path | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| Outbound delivery | the endpoint's own **Rate limit** setting (see [Endpoints](./04-endpoints.md#settings)) | `endpoint` policy (specific, else every-endpoint) | `project` policy | `organization` policy |
| Ingest | `ingest` policy (specific key, else every-key) | `project` policy | `organization` policy | - |

A refused publish answers 429 with `Retry-After` and names the scope that
refused. A refused delivery is deferred, not failed, and does not spend an
attempt.

::: warning Which of these are enforced today
- **Ingest** policies (`ingest`, `project`, `organization` scope on the
  inbound path) are enforced by the ingest service. If no ingest-scope policy
  exists, the installation's configured platform ceiling applies instead.
- **On the outbound path, only the endpoint's own Rate limit setting is
  enforced today.** `endpoint`, `project` and `organization` scope policies
  are stored, validated and listed, but the delivery workers do not yet
  consult them. A row in the list is not yet a ceiling in force on delivery.
:::

Changes take effect across the platform within about 30 seconds: the
delivery and ingest services cache the policy set for that long, and nothing
you do invalidates it early. If the shared limiter store is unavailable,
limits are enforced per replica rather than fleet-wide, and they are never
the reason a request is refused for anything but running out of tokens.

A project may hold 300 rate-limit policies. Rate-limit policies are
hard-deleted; removing the last policy covering a resource means it falls
back to the next scope up.

## Attaching a policy to an endpoint

- **Retry policy**: choose it in the endpoint's **Edit** dialog. The picker
  lists only this project's policies, marks the default, and keeps a saved
  policy visible even if it is not on the first page, so saving cannot
  silently unset it. Choosing "Project default" clears the attachment.
- **Rate limit**: the endpoint's own **Rate limit** and **Rate limit window**
  fields are the per-endpoint ceiling that is enforced today. A
  rate-limit *policy* at `endpoint` scope is attached by naming the endpoint
  as its `resource_id` through the API.

---

**Where this comes from** (for maintainers):
`apps/dashboard/src/features/retry-policies/api.ts` (`describeRetryPolicy`),
`apps/dashboard/src/features/endpoints/EndpointEditDialog.tsx` (`RetryPolicyField`),
`apps/dashboard/src/features/settings/ProjectSettingsPage.tsx`,
`apps/control-api/src/retry-policies/*` (`retry-policy-limits.ts`, `retry-policy-rules.ts`,
`retry-policies.service.ts`, `retry-policies.controller.ts`, DTOs),
`apps/control-api/src/rate-limits/*` (`rate-limit-limits.ts`, `rate-limit-rules.ts`,
`rate-limit-resource.ts`, `rate-limits.service.ts`, `rate-limits.controller.ts`, DTOs),
`services/data-plane/internal/retry/retry.go` (`DefaultPolicy`, `ShouldRetry`, `Delay`),
`services/data-plane/internal/router/plan.go` (`ResolveMaxAttempts`),
`services/data-plane/internal/ratelimit/policy.go` (`ResolveIngest`, `ResolveDelivery`,
`BucketFor`), `limiter.go` (`AllowDelivery` docblock: delivery path not wired),
`source.go` (`DefaultCacheTTL`), `services/data-plane/cmd/webhookd/ratelimit.go`.
