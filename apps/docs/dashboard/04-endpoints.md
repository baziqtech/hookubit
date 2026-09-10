# Endpoints

An endpoint is a URL the platform delivers to, together with everything that
keeps one slow or broken consumer from affecting the others: its own timeout,
its own concurrency, its own rate limit, its own circuit breaker and its own
signing secrets.

## The list

`/orgs/:orgId/projects/:projectId/endpoints` shows each endpoint's name and
URL, its status (with `auto-disabled` or `operator paused` alongside when that
is the case, and the platform's reason in red when it disabled the endpoint
itself), its limits (`rate/window`, timeout, concurrency), when it was created,
and its actions: the pause/resume control for its state, **Delete**, **Edit**
and **Secrets**. An endpoint with nothing signing for it also carries a
`no live secret` badge, and its Secrets button is highlighted, because that
is the only control that can make it deliver. **Show deleted endpoints** adds
the soft-deleted ones; they are kept forever so the delivery ledger stays
readable, and they have no actions.

## Creating an endpoint

**Add endpoint** asks for a name and a URL. Everything else takes the default
and can be changed afterwards with **Edit**.

### URL rules

The URL is checked when you save, so an unusable one is refused now rather
than becoming silent delivery failures later. Refused:

- anything that is not `http` or `https`;
- credentials in the URL (`https://user:pass@...`) - they would end up in
  delivery logs and support tickets;
- `localhost` and anything under it, and literal addresses that are loopback,
  private, link-local, multicast, carrier-grade NAT, documentation,
  benchmarking or reserved ranges, and cloud instance-metadata addresses -
  including the disguised forms (IPv4-mapped and 6to4/NAT64 IPv6 that embed
  such an address);
- whitespace or control characters, and anything over 2048 characters.

A hostname passes this check because nothing is resolved at save time. It is
checked again, against the address it actually resolves to, at the moment of
each delivery, which is where a hostname that resolves into private space is
stopped. An installation that deliberately delivers to private networks can
allow specific ranges; metadata addresses are refused regardless.

### Who sees the secret decides whether it goes live

Creating an endpoint also mints its **version 1 signing secret**. What
happens next depends on your role:

| You are | Result |
|---|---|
| Owner or admin | The endpoint is **active** and the dialog shows the secret once, with a copy button. Hand it to whoever runs the consumer; it is not retrievable afterwards. |
| Developer | The endpoint is created **paused** and the dialog says so: "This endpoint is paused and will not receive deliveries yet." You may create endpoints but may not read signing secrets, so there is no key you can hand over. **An owner or admin must rotate the secret** (which returns the new plaintext to them), give it to the consumer, and then enable the endpoint. The dialog offers **Open secrets for this endpoint**, which is where that rotation happens - and which names the role required if yours is not enough. |

Going live without a handover would sign every delivery with a key nobody
holds - the consumer would reject all of them, and the rotation that fixed it
would change the key again. Two verification outages instead of none.

See [Secrets and rotation](/guide/06-secrets-and-rotation) for what the
consumer does with the secret.

## Settings

**Edit** exposes every setting. Only the fields you changed are sent, so
renaming an endpoint does not re-run the URL check on a URL you did not touch.

| Field | Range | Default | Notes |
|---|---|---|---|
| Name | 1 to 200 characters | - | |
| URL | up to 2048 characters | - | Rules above. |
| Description | up to 1000 characters | empty | |
| Timeout (ms) | 1 000 to 120 000 | 30 000 | How long one attempt may hold a worker slot. Too short fails every attempt before the handshake finishes and burns the retry budget. |
| Max concurrency | 1 to 256 | 16 | In-flight attempts allowed against this endpoint at once. |
| Rate limit | 1 to 100 000, or blank | blank (no limit) | Deliveries per window. |
| Rate limit window (seconds) | 1 to 3 600 | 1 | The window the limit is counted over. |
| Retry policy | one of this project's policies, or Project default | Project default | See [Retry policies](./06-retry-and-rate-limit-policies.md#retry-policies). An id from another project answers "Resource not found". |
| Custom headers | up to 20, one per line as `Name: value` | none | Name up to 128 characters, value up to 1024, 8192 bytes in total. |

### Custom headers

Custom headers are merged into every request the platform sends to this
endpoint, which makes them the place to put a bearer token your consumer
requires. Because they are merged into a request the platform signs, some
names are **refused at save time** rather than filtered later:

| Refused | Why |
|---|---|
| Any `Webhook-*` header | The whole namespace carries the signature and delivery identity (`Webhook-Id`, `Webhook-Signature`, `Webhook-Timestamp`, ...). A second `Webhook-Signature` would let a consumer verify a webhook the platform never signed. |
| `Authorization` | It would override the credential the request is made with. |
| `Host`, `Content-Length`, `Transfer-Encoding` | They frame the request; a caller-supplied framing header is how one request becomes two. |

Also refused: a name listed twice in different cases (header names are
case-insensitive), a value containing a carriage return or line feed (header
injection), and non-token characters in a name. The dashboard checks these as
you type, in the same words the server uses.

Custom header **values** are redacted to `[redacted]` when they are shown
back on a delivery's attempt (for `authorization`, `proxy-authorization`,
`cookie`, `x-api-key`, `api-key` and `x-auth-token`), because viewers can
read deliveries but not credentials. The name stays, so "did we send it?" is
still answerable.

## Health and the circuit breaker

An endpoint has two flags, and telling them apart is the most important
thing on this page:

- **`enabled`** is what a person asked for.
- **`status`** is the current state, and the platform writes it too.

| `status` | `enabled` | Badge | What it means |
|---|---|---|---|
| `active` | true | `active` | Delivering. |
| `paused` | false | `paused` + `operator paused` | A person paused it, or it is waiting for a signing secret. |
| `disabled` | true | `disabled` + `auto-disabled` | **The platform switched it off** after its circuit breaker had been open for a long time. Nobody chose this. The reason (starting `auto-disabled:`) is shown under the URL. |
| `deleted` | false | `deleted` | Soft-deleted. Kept for the ledger; no actions. |

```mermaid
stateDiagram-v2
    [*] --> paused: created by a developer (secret_pending)
    [*] --> active: created by an owner or admin
    active --> paused: Pause deliveries (reason to audit log)
    paused --> active: Resume deliveries (needs a live secret)
    active --> disabled: auto-disable after the breaker has been open 72h
    disabled --> active: Resume deliveries anyway (clears the reason, arms one probe)
    disabled --> paused: Pause it instead (turns the verdict into a decision)
    active --> deleted: Delete
    paused --> deleted: Delete
    disabled --> deleted: Delete
```

### The breaker

Underneath `status`, every endpoint has a health record the delivery workers
keep. It is not shown as a field, but it explains what you see:

| Health | Meaning |
|---|---|
| healthy | Deliveries flow. |
| degraded | 3 consecutive failures. Flagged, not yet throttled. |
| open | **5 consecutive failures.** No deliveries are attempted; each is deferred. A cooldown of 30 seconds starts, doubling on every further failure up to 10 minutes, with jitter. |
| half-open | The cooldown expired. Exactly **one** delivery is let through as a probe. One success closes the breaker and the backlog drains; one failure re-opens it with its cooldown intact. |

An open breaker removes request pressure from a dead consumer within five
failures. It does not stop new deliveries being *created* for it - every new
matching event still becomes a row that is claimed, refused, deferred and
eventually expires. That is what auto-disable is for.

### Auto-disable

Every 15 minutes the platform looks for endpoints whose breaker has been
**continuously open for 72 hours** (an installation may set this higher, never
below 24) and switches them off, at most 200 per pass. "Continuously" is
literal: a single successful probe closes the breaker and resets the clock, so
72 hours open means 72 hours without one success. The window sits above both
a delivery's default retry budget (24 hours) and a weekend maintenance window,
so an endpoint is not disabled while its first affected deliveries are still
being retried or because a consumer was down from Friday night to Monday
morning.

When it happens:

- `status` becomes `disabled`, `enabled` stays true (you never chose this),
  and the reason is written in a sentence you can read on the endpoint:
  *"auto-disabled: the circuit breaker had been open for 3d 2h (430
  consecutive failures, last successful delivery: ...). New events are no
  longer queued for this endpoint. Re-enable it once the endpoint is
  answering."*
- An audit entry `endpoint.auto_disabled` is written with no user actor - it
  was the platform. See [the audit log](./08-analytics-usage-and-audit.md#the-audit-log).
- **New events stop producing deliveries** for this endpoint.
- **Deliveries already queued are finished as `cancelled`** ("we stopped on
  purpose"), not failed. They drain in one pass rather than expiring one at a
  time over the next day.

Auto-disable can be turned off by your installation's operator, at the cost
described above.

## Pause, resume and "resume anyway"

The buttons on a row depend on how it stopped, and the wording is deliberate:

| Row state | Buttons |
|---|---|
| Delivering | **Pause deliveries**, Delete |
| Paused by a person (or awaiting a secret) | **Resume deliveries**, Delete |
| Auto-disabled | **Resume deliveries anyway**, **Pause it instead**, Delete |
| Deleted | none ("kept for the ledger") |

**Pause deliveries** asks for an optional reason (up to 200 characters) that
is written to the audit log - which is what makes the delivery gap
explainable next week. Pausing sets `status: paused`, and leaves the
platform's own `disabled_reason` untouched, so "the platform stopped this" and
"a person stopped this" stay separable afterwards.

### What pausing does to the queue

The pause dialog states it before the button: **queued deliveries are
cancelled, not held.** This is what the delivery workers actually do, not a
policy the dashboard chose:

| Delivery | On pause |
|---|---|
| Already queued, scheduled or retrying for this endpoint | Finished as `cancelled` ("we stopped on purpose") the moment a worker claims it - not retried, not failed. A retry that is not due yet is cancelled when it comes due. |
| Published while the endpoint is paused | **No delivery row is created for this endpoint at all.** The router skips a non-active endpoint at fan-out rather than buffering rows that every worker poll would claim and put back. |
| Already recorded in the ledger | Untouched. Nothing is erased. |

So resuming an endpoint does not send anything from the gap. The resume
dialog says so too: events published during the pause produced no deliveries
for this endpoint, and deliveries that were queued when it was paused were
cancelled. Use [replay](./07-events-and-deliveries.md#replay) for anything
that must still arrive once the endpoint is back; cancelled deliveries can be
replayed.

**Resume deliveries** (`enable`) is refused with a conflict when the endpoint
has **no live signing secret**: the platform fails closed rather than deliver
unsigned, so enabling would only queue failures. The dashboard knows this in
advance through `has_live_secret`: on such an endpoint the resume dialog says
why it cannot be resumed and offers **Open secrets** instead of the refusal.
Resuming also clears the platform's `disabled_reason`.

**Resume deliveries anyway** is the same operation with different words,
because the situation is different. Re-enabling an auto-disabled endpoint
changes nothing about the consumer whose failures opened the breaker. If it
is still failing, the next run of failures opens the breaker again and the
endpoint is disabled a second time. The confirmation says so: "Nothing here
has been fixed." What resuming *does* do is bring the breaker's next probe
forward to now instead of waiting out a cooldown that has doubled to its
ten-minute ceiling - while still admitting exactly **one** delivery until the
endpoint answers. A backlog is never released at an endpoint whose recovery
has not been observed. If the probe succeeds the backlog drains normally.

**Pause it instead** converts the platform's verdict into a recorded operator
decision with a reason, and stops the retry churn while the consumer is
fixed.

## Signing secrets

Every endpoint has one or more HMAC signing secrets (`whsec_...`), and a live
endpoint must always have at least one that is signing. During a rotation
window there are two, every delivery carries one signature per active secret,
and a consumer verifying with either one succeeds - which is what lets
consumers roll without dropping a delivery.

Reading and rotating secrets needs `endpoint-secrets.*` - **owner and admin
only** - and a viewer or developer gets "You cannot read or rotate this
endpoint's signing secrets", naming their role, even though they can see the
endpoint.

**Secrets** on a row opens the endpoint's secrets dialog:

| Column | Meaning |
|---|---|
| Version | Monotonic per endpoint; the highest is the newest. |
| State | `signing` (no end scheduled), `signing until` a time (inside a rotation's overlap window, with the moment it stops), or `retired` (rotated out and expired, or revoked). This is the server's own `active` flag, which already folds in the expiry. |
| Superseded | When a rotation put a clock on it. |
| Created | When it was minted. |
| (actions) | **Revoke**, on versions that still sign. |

No row carries a plaintext. A secret is shown exactly once, in the response
that mints it, and cannot be recovered afterwards by anyone - rotate if it is
lost.

### Rotating

**Rotate secret** asks for one thing, the **overlap** in seconds:

| Overlap | What happens |
|---|---|
| 86 400 (the default, 24 hours) up to 2 592 000 (30 days) | The new secret signs immediately and the current ones keep signing for that long, then stop. During the window every delivery carries one signature per active secret, and a consumer verifying with either one succeeds - so the consumer can be switched without dropping a delivery. |
| 0 | The current secrets stop signing **immediately**. A consumer still verifying with the old one rejects every delivery until it is switched. The dialog turns red and says "use this for a leaked secret, not for a routine rotation". |

A rotation never shortens a window a consumer was already promised: a
version whose existing expiry is earlier than the new deadline keeps it.

The next screen shows the new plaintext once, with a copy button and the
one-time warning, and beneath it which prior versions still sign and until
when (`overlapping_versions` and `previous_secrets_expire_at` on the wire).
Switch the consumer before that moment and nothing is dropped.

On an endpoint with nothing signing (`secret_pending`, or after every version
was retired) the same button reads **Issue secret**: there is no window to
overlap, and once the consumer holds the plaintext the endpoint can be
resumed.

### Revoking one version

**Revoke** stops one version signing immediately. It is **refused when that
version is the only one still signing** for a live endpoint, because that
state makes every delivery fail closed. The dialog knows this in advance when
the list fits on one page and says so; when the server refuses anyway, its
sentence is shown whole. Either way the remedy is a button: **Rotate with
zero overlap instead**, which reaches the same end state - that secret stops
signing - with a new one taking over at the same moment.

The same operations through the API:
`GET /v1/endpoints/:endpointId/secrets` (metadata only),
`POST /v1/endpoints/:endpointId/secrets/rotate` with `{ overlap_seconds }`,
and `DELETE /v1/endpoints/:endpointId/secrets/:secretId`. The full rotation
procedure is in [Secrets and rotation](/guide/06-secrets-and-rotation).

## Test delivery

There is no "send a test delivery" button. To exercise an endpoint end to
end, publish a test event that a subscription routes to it - the
[Get started](./09-onboarding.md) page has the request ready - and follow it
into Deliveries.

## Deleting an endpoint

Deleting an endpoint is a **soft delete**: the row stays, with `status:
deleted`, and every delivery and attempt that ever pointed at it keeps
pointing at it, so a ledger entry from months ago still shows the URL it went
to. The endpoint disappears from the default list (tick **Show deleted
endpoints** to see it), cannot be modified (every write against it is a
conflict), and no longer receives deliveries. A subscription cannot be
pointed at it. Deleting is idempotent.

The delivery ledger makes a hard delete impossible by construction, and there
is no undelete.

**Delete** on a row opens a confirmation that says exactly that: the endpoint
stops receiving deliveries, its status becomes `deleted`, every later change
is refused, its signing secrets go with it, and the row is kept forever so
every delivery and attempt that pointed at its URL keeps pointing at it.
Subscriptions bound to it stop matching (a non-active endpoint is skipped at
fan-out); delete or re-point them separately. The same operation through the
API is `DELETE /v1/projects/:projectId/endpoints/:endpointId`.

## Limits

A project may hold **500 live endpoints** (deleted ones do not count), and
endpoint creation is rate limited to 60 per five minutes per address. Each
endpoint costs more than its row - a minted, encrypted secret and a slice of
the delivery workers' per-endpoint bookkeeping - which is why the ceiling
exists.

---

**Where this comes from** (for maintainers):
`apps/dashboard/src/features/endpoints/EndpointsPage.tsx`, `EndpointActions.tsx`
(pause, resume, delete), `EndpointSecretsDialog.tsx` and `secrets.ts` (the
overlap copy and the last-active rule), `EndpointEditDialog.tsx`, `breaker.ts`,
`custom-headers.ts`, `api.ts`,
`apps/control-api/src/endpoints/endpoints.controller.ts`, `endpoints.service.ts`,
`endpoint-url.ts`, `endpoint-headers.ts`, `endpoint-limits.ts`,
`dto/create-endpoint.dto.ts`, `dto/endpoint-response.dto.ts`,
`apps/control-api/src/endpoint-secrets/endpoint-secrets.controller.ts`,
`endpoint-secrets.service.ts`, `secret-generator.ts` (overlap bounds),
`apps/control-api/src/maintenance/auto-disable-policy.ts`,
`endpoint-auto-disable.service.ts`, `auto-disable.scheduler.ts`,
`apps/control-api/src/config/env.schema.ts` (`ENDPOINT_AUTO_DISABLE_*`),
`apps/control-api/src/deliveries/delivery-limits.ts` (redacted request headers),
`services/data-plane/internal/worker/breaker.go` (`DefaultBreakerConfig`),
`services/data-plane/internal/egress/ssrf.go`, `services/data-plane/internal/router/plan.go`
(`gate()`: a non-active endpoint is skipped at fan-out),
`services/data-plane/internal/worker/store.go` (`Endpoint.Deliverable()`) and
`worker/deliver.go` (a claimed delivery for a paused endpoint is finished
`cancelled`). "What pausing does to the queue" was verified against those
three files; the pause dialog used to say "they wait", and the `disable`
route description in `endpoints.controller.ts` was the accurate one.
