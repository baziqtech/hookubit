# 0004 — `ordering_key` is stored from day one; enforcement is deferred

Status: Accepted

## Decision

`deliveries.ordering_key` exists in the schema now and is populated from the
ingest API. The MVP does not serialise delivery by key. The platform documents
at-least-once, unordered delivery.

## Why it exists

Adding the column later is a migration over the largest table in the system.
Adding the *guarantee* later is a change to the claim query and the retry loop.
The cheap half is done now; the expensive half waits for a real requirement.

## What it prevents

- Promising an ordering guarantee the retry engine cannot honour. Ordering plus
  retries means a failing event must block every later event sharing its key —
  which converts one bad endpoint into an unbounded per-key backlog.
- A painful backfill of a nullable column across millions of rows.

## How it scales

Not enforcing it is what scales. Strict per-key ordering caps concurrency at one
in-flight delivery per key, so it must stay opt-in per subscription
(ARCHITECTURE.md 27).

## Migration path

When required: add a partial unique index ensuring at most one non-terminal
delivery per `(endpoint_id, ordering_key)`, have the claim query skip keys with
an older incomplete delivery, and add a per-key head-of-line timeout so a
poisoned event eventually yields. Ship it behind a per-subscription flag and
measure the backlog before defaulting it on.
