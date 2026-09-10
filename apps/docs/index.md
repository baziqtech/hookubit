---
layout: home

hero:
  name: hookubit
  text: Webhooks that arrive.
  tagline: Durable ingestion, materialised fan-out, retries with backoff, signed deliveries, and a delivery log that answers "what happened to this event?" — without a support ticket.
  actions:
    - theme: brand
      text: Get started
      link: /guide/02-quickstart
    - theme: alt
      text: Receiving webhooks
      link: /guide/04-receiving-webhooks
    - theme: alt
      text: API reference
      link: /api/

features:
  - title: Guide
    details: Publish an event, receive it, verify the signature, and understand exactly what happens between the two — retries, ordering, duplicates, rotation, replay.
    link: /guide/
    linkText: Read the guide
  - title: Dashboard
    details: Organizations and roles, projects, endpoints, subscriptions, API keys, retry and rate-limit policies, and the delivery log — the screens and what they mean.
    link: /dashboard/
    linkText: Tour the dashboard
  - title: API reference
    details: Every endpoint of the ingest and control APIs. The reference is generated from the same OpenAPI document the product itself is built from, so it cannot drift.
    link: /api/
    linkText: Browse the API
  - title: Self-hosting
    details: Run hookubit against your own PostgreSQL — Helm chart, raw manifests or Compose, every configuration key, mail, observability, backup and upgrades.
    link: /self-hosting/
    linkText: Deploy it yourself
---

## What hookubit does

You publish an event once. hookubit stores it durably before it answers, works
out which of your endpoints subscribed to it, and delivers to each one
independently — with its own retry chain, its own signature, its own attempt
history. If an endpoint is down for an hour you lose time, not events. If it
is down for days, its circuit breaker opens, it is eventually disabled, and
one click brings it back without a thundering herd.

Every delivery is signed over the exact bytes sent, so the receiver can prove
who sent it and that nothing changed in transit. Every attempt is recorded, so
"did finance ever receive order 41F9?" is a page in the dashboard, not a
database query.

## Two guarantees, stated once

**At-least-once.** A delivery is retried until it succeeds or its budget runs
out, and a retry can arrive after an earlier attempt already got through —
your receiver must be idempotent, keyed on `Webhook-Id`.

**Nothing published before COMMIT.** The `202 Accepted` you get back means the
event and its fan-out instruction are on disk. Anything that happens after
that — a crash, a deploy, a database failover — costs latency, never the event.

## Reading these docs

The guide is written in reading order; the API reference is generated from
the control plane's own OpenAPI document on every build, so a field on this
site is a field the product has. If a page and the product disagree, the
product wins — and we would like to know.
