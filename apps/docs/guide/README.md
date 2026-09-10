# Integration guide

How to publish events to hookubit and receive them as signed webhooks, what the platform guarantees while doing it, and what to do when a delivery does not arrive.

This guide is written for the developer on either side of the pipe: the service that publishes events, and the service that receives webhooks. It assumes nothing about the dashboard beyond what it says here; the dashboard has [its own section](/dashboard/), and every field and route mentioned in this guide is specified in the [API reference](/api/).

## Reading order

Read 01 first. After that, 03 if you publish, 04 if you receive, and the rest when you need them.

| # | Page | Read it when |
|---|---|---|
| 01 | [Concepts and guarantees](./01-concepts.md) | First. The vocabulary, the two guarantees, and the path an event takes. |
| 02 | [Quickstart](./02-quickstart.md) | You want a webhook on your screen in ten minutes. |
| 03 | [Publishing events](./03-publishing-events.md) | You are writing the code that calls the ingest API: the request, idempotency, limits, and every error code. |
| 04 | [Receiving webhooks](./04-receiving-webhooks.md) | You are writing the receiver. Signature verification, with tested samples in Node.js, Python, Go and PHP. |
| 05 | [Retries and delivery](./05-retries-and-delivery.md) | You want to know what happens when your endpoint is down: the schedule, the state machine, the circuit breaker, auto-disable. |
| 06 | [Secrets and rotation](./06-secrets-and-rotation.md) | You need to rotate a signing secret without dropping a delivery. |
| 07 | [Replay](./07-replay.md) | You need to re-send something, and want to know exactly what gets re-sent. |
| 08 | [Troubleshooting](./08-troubleshooting.md) | Something did not arrive and you need to find out why. |
| - | [Glossary](./glossary.md) | A term is doing work you do not recognise. |

## Conventions used in this guide

| Convention | Meaning |
|---|---|
| `proj_…`, `ep_…`, `sub_…`, `key_…`, `evt_…`, `del_…`, `req_…` | Identifier prefixes for a project, endpoint, subscription, API key, event, delivery and request. Every id is a prefix plus a ULID, so ids sort by creation time. |
| `wk_test_…` / `wk_live_…` | An ingest API key for a `test` or `live` project. The prefix is part of the key. |
| `whsec_…` | An endpoint signing secret. The prefix is part of the secret: store the whole string. |
| "by default" | The value is set by the operator of your installation; the number given is what ships. |
| `Webhook-*` | The request headers hookubit sets on every delivery. A receiver verifies against these names. |

Two surfaces are involved, and they are separate services with separate base URLs:

- **The ingest API** receives events. One route, `POST /v1/projects/{project_id}/events`, authenticated with an API key. Its base URL is shown on your project's *Get started* page in the dashboard.
- **The control API** is everything else - projects, endpoints, subscriptions, keys, the delivery ledger, replay. The dashboard is a client of it; so can you be, with a browser session or an API key that carries control-plane scopes. Its reference is [generated from the API itself](/api/).

::: tip If the docs and the product disagree
The product wins. Every page here ends with the source files it was written from, so a maintainer can check the claim - then tell us.
:::
