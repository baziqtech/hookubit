# Quickstart

From nothing to a signed webhook arriving at a URL you own. Ten minutes if the account already exists.

You will do four things in the dashboard, then one `curl`.

## 0. Sign in

Open the dashboard for your installation and sign in.

::: warning Registration may be invitation-only
Self-serve registration is off unless the operator has enabled it (`ALLOW_OPEN_REGISTRATION=true`). On an installation where it is off, `POST /v1/auth/register` answers `forbidden` and the *Register* page will tell you to ask an organization owner for an invitation. Invitations arrive by email and are redeemed at `/accept-invitation`.
:::

If you registered yourself, an organization was created for you and you are its owner. If you were invited, you are a member with the role the inviter chose - which matters in step 2.

## 1. Create a project

*Organization → New project.* Give it a name. Its **environment** is `test` unless you choose `live`, and it **cannot be changed later**. Everything below lives inside this project; every API key issued in it will carry the matching `wk_test_` or `wk_live_` prefix.

## 2. Create an endpoint

*Project → Endpoints → New endpoint.* Two fields are required:

| Field | Value |
|---|---|
| `name` | Anything you will recognise in a list. |
| `url` | Where deliveries go. `http` or `https`, no credentials in the URL. It must be reachable from the platform, so on a hosted installation `localhost` and private addresses are refused at save time - see the [URL rules](./04-receiving-webhooks.md#url-rules). |

The response shows the endpoint's **version 1 signing secret** (`whsec_…`) **once**. Copy it into your receiver's configuration now; there is no route that returns it again. If you lose it, [rotate](./06-secrets-and-rotation.md) and use the new one.

::: warning If you are a `developer`, the secret is withheld and the endpoint starts paused
Reading signing secrets is an owner/admin permission. An endpoint created by a developer comes back with `secret: null` and `secret_pending: true`, in status `paused`, so it does not sign deliveries with a key nobody holds. An owner or admin then rotates the secret (which returns the new plaintext to them), hands it to whoever runs the receiver, and enables the endpoint. Events published while an endpoint is paused are **not** queued for it - fan-out skips a paused endpoint - so do this before you publish anything you care about.
:::

Defaults you can leave alone for now: `timeout_ms` 30000, `max_concurrency` 16, no rate limit, the project's default retry policy.

## 3. Subscribe the endpoint

*Project → Subscriptions → New subscription.* Choose the endpoint and the event types. For the quickstart, either `*` (everything) or the exact type you are about to publish, `order.created`.

A subscription is `enabled` by default. A disabled subscription matches nothing.

## 4. Issue an API key

*Project → API keys → New key.* Give it a name. The plaintext key (`wk_test_…`) is shown **once**; only its hash is stored. Copy it.

Leave `scopes` empty: an ingest-only key needs none. `expires_at` is optional.

## 5. Publish an event

The ingest API is a separate service from the dashboard. Its base URL is on the project's *Get started* page; in a local setup it is `http://localhost:8080`.

```bash
curl -i -X POST "$INGEST_BASE_URL/v1/projects/$PROJECT_ID/events" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order_123_created" \
  -d '{"event_type":"order.created","data":{"order_id":"ord_123","amount":120.5}}'
```

```http
HTTP/1.1 202 Accepted
Content-Type: application/json
X-Request-Id: req_01M24GHG1AB10B91Z0210MA66J

{"id":"evt_01J…","status":"accepted"}
```

`accepted` means the event is committed and will be fanned out. It does not mean delivered. Keep the `id`: it is the `Webhook-Id` your receiver is about to see.

If you get a `401`, the key is wrong or belongs to a different environment; a `404` means the project id in the path does not match the key's project. Every error carries a `request_id` - see [Publishing events](./03-publishing-events.md#errors).

## 6. Watch it arrive

Within a second or two your endpoint receives:

```http
POST /your/webhook/path HTTP/1.1
Content-Type: application/json
User-Agent: HookuBit/1.0
Webhook-Id: evt_01J…
Webhook-Delivery-Id: del_01J…
Webhook-Event-Type: order.created
Webhook-Attempt: 1
Webhook-Timestamp: 1757155200
Webhook-Signature: t=1757155200,v1=7f10b704e963699398001b1b5031d34050f97358cae72cd36f0f6bbbe9015697

{"event_type":"order.created","data":{"order_id":"ord_123","amount":120.5}}
```

The body is the exact bytes you published. Respond with any `2xx`.

In the dashboard, *Project → Deliveries* shows one row per endpoint the event reached; open it for the attempt, its HTTP status and the response your receiver sent. *Project → Events* shows the event itself, with its fan-out state.

If nothing arrives, start at [Troubleshooting](./08-troubleshooting.md#nothing-arrived).

## The same thing over the API

Everything the dashboard did is a control-API call. Browser sessions use a cookie; server-to-server calls use an API key that carries the relevant control-plane scopes.

| Step | Route | Body |
|---|---|---|
| Project | `POST /v1/organizations/{orgId}/projects` | `{"name": "…", "environment": "test"}` |
| Endpoint | `POST /v1/projects/{projectId}/endpoints` | `{"name": "…", "url": "https://…"}` - the response's `secret` is shown here and nowhere else |
| Subscription | `POST /v1/projects/{projectId}/subscriptions` | `{"endpoint_id": "ep_…", "event_types": ["order.created"]}` |
| API key | `POST /v1/projects/{projectId}/api-keys` | `{"name": "…"}` - the response's `key` is shown here and nowhere else |
| Event | `POST {ingest}/v1/projects/{projectId}/events` | see step 5 |
| Deliveries | `GET /v1/projects/{projectId}/events/{eventId}/deliveries` | - |

Field-level detail for each is in the [API reference](/api/).

## Next

- Verify the signature before you trust the body: [Receiving webhooks](./04-receiving-webhooks.md).
- Send the `Idempotency-Key` on every publish, and know what happens on a 429: [Publishing events](./03-publishing-events.md).

---

*Where this comes from:* `apps/control-api/openapi.json` (routes and required fields); `apps/control-api/src/auth/auth.service.ts` (`ALLOW_OPEN_REGISTRATION`); `apps/control-api/src/projects/dto/create-project.dto.ts` (`environment` default and immutability); `apps/control-api/src/endpoints/dto/endpoint-response.dto.ts` (`secret`, `secret_pending`); `apps/control-api/src/endpoints/endpoint-limits.ts` (defaults); `apps/control-api/src/api-keys/api-keys.controller.ts`; `apps/dashboard/src/features/onboarding/GetStartedPage.tsx` (ingest base URL); `apps/dashboard/src/routes/router.tsx` (page paths); `services/data-plane/internal/worker/headers.go`; the 202 and error responses were checked against a local ingest instance.
