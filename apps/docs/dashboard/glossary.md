# Glossary

The words the dashboard uses, in the sense it uses them.

| Term | Meaning |
|---|---|
| **Attempt** | One HTTP request made for a delivery. Carries the status code (or none, for a transport failure), duration, request and response headers, response body, error and trace id. Append-only. |
| **Auto-disabled** | An endpoint the **platform** switched off after its circuit breaker had been open continuously for 72 hours. `status: disabled` with `enabled` still true, and a `disabled_reason` starting `auto-disabled:`. Nobody chose it. |
| **Circuit breaker** | Per-endpoint protection in the delivery workers: degraded at 3 consecutive failures, open at 5 (deliveries deferred, cooldown 30s doubling to 10 minutes), half-open for one probe, closed again on one success. |
| **Claims** | On an outbox row, how many times a router has picked it up. Monotonic. |
| **Delivery** | One event to one endpoint, with its own retry chain. Created at routing, before anything is sent, so the ledger is the record of what should arrive. |
| **Effective scopes** | What an API key may do on the control plane *right now*: its minted scopes intersected with the permissions its issuer's current role holds. Empty once the issuer has left the organization. |
| **Enabled** | Operator intent on an endpoint (or subscription): a person wants it delivering. Distinct from `status`, which the platform also writes. |
| **Environment** | `test` or `live`, fixed when a project is created. Decides the key prefix (`wk_test_` / `wk_live_`). |
| **Event** | A fact your system published, once, with its payload. Its status is the ingest and routing state, not a delivery outcome. |
| **Event type** | A dot-separated name such as `payment.settled`. Subscriptions match on it exactly, by prefix (`payment.*`), or with `*`. |
| **Exhausted** | A delivery that used every attempt (or its whole time budget) and never succeeded. Final; only a replay revisits it. |
| **Failing now** | The deliveries filter for `retrying`, `failed` and `exhausted` together. |
| **Routing** | Turning one accepted event into one delivery row per matching subscription. Pinned to the subscriptions that existed when the event was accepted. |
| **Routing cursor** | On an outbox row, the point a wide routing reached before it stopped. A requeue resumes from it. |
| **Has live secret** | Whether an endpoint has at least one signing secret that is active and unexpired. False means Resume will be refused. |
| **Idempotency key** | A key the producer sends with an event so that re-publishing returns the same event instead of creating another. |
| **Invitation** | A single-use, 7-day token emailed to an address, redeemed while signed in as that address. Consumed before its checks run, so accepting from the wrong account uses it up. |
| **Ordering key** | An optional per-event key stored and carried onto deliveries. Ordering is **not** enforced. |
| **Organization** | The billing and people boundary. Owns members, roles and the audit log; contains projects. |
| **Stuck events** | The screen listing events that were accepted and never turned into deliveries, with why each one stopped and whether putting it back will help. The API resource behind it is still called `outbox`. |
| **Outbox** | The router's record of what it still owes each accepted event — the mechanism behind *Stuck events*. |
| **Parked** | An outbox row (`status: failed`) the router gave up on. The event is `failed` and has no deliveries; nothing will deliver it until it is requeued. |
| **Paused** | An endpoint a person stopped (`status: paused`, `enabled: false`), or one created by a developer and waiting for a signing secret. |
| **Payload filter** | A JSON predicate on the event body attached to a subscription. Validated and stored, **not yet evaluated** by the routers. |
| **Permission** | A named grant such as `endpoints.write`. Roles are sets of permissions; the matrix is in [Accounts and teams](./01-accounts-and-teams.md#roles-and-permissions). |
| **Project** | One environment of one system. Owns keys, endpoints, subscriptions, policies, events and deliveries. |
| **Rate-limit policy** | A ceiling at `endpoint`, `project`, `organization` or `ingest` scope. Nested budgets: every applicable one is charged. |
| **Replay** | A new delivery row for a stopped one, carrying `replay_of_delivery_id`. The original is untouched. Re-sends to endpoints the event actually reached. |
| **Requeue** | Putting a parked outbox row back so the router runs the routing it never ran. Not a replay. |
| **Retry policy** | The backoff curve for an endpoint: strategy, attempts, delays, jitter and time budget. One per project is the default. |
| **Role** | Owner, admin, developer, viewer or billing, held per organization. |
| **Scopes** | The control-plane permissions an API key was minted with. A snapshot; see effective scopes. |
| **Signing secret** | The `whsec_` HMAC key an endpoint's deliveries are signed with. Shown once when minted or rotated; several can overlap during rotation. Owner and admin only. |
| **Slug** | A URL-safe identifier for an organization (unique platform-wide, up to 48 characters) or a project (unique within its organization, up to 64). |
| **Soft delete** | Marking a project or endpoint `deleted` while keeping the row, so the delivery ledger stays readable. There is no hard delete for either. |
| **Subscription** | The routing rule binding an endpoint to event types (and optionally a payload filter). |
| **Terminal** | A delivery state after which no further attempt will be made: `succeeded`, `exhausted`, `cancelled`. |
| **Trace id** | The identifier of an attempt's span in your tracing backend, present only when that attempt was sampled. |
| **Unaccounted** | On an outbox row, claims that ended with the router recording nothing (a crash or lapsed lease). More than 5 parks the row. |
| **`Webhook-Id`**, **`Webhook-Signature`**, **`Webhook-Timestamp`** | The headers every delivery carries. Reserved; a custom header cannot use the `Webhook-` prefix. |

---

**Where this comes from** (for maintainers): the pages of this section, each
of which names its own sources.
