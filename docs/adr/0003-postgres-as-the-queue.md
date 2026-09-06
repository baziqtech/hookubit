# 0003 — PostgreSQL `FOR UPDATE SKIP LOCKED` is the MVP queue

Status: Accepted

## Decision

Ready work is claimed straight from the `deliveries` table with
`SELECT … FOR UPDATE SKIP LOCKED`, behind the `queue.Queue` interface. Redis is
used for rate limiting, circuit-breaker state and configuration caching — never
as the record of what must be delivered. SQS, Kafka and NATS are future
implementations of the same interface.

## Why it exists

ARCHITECTURE.md 15 already requires `SKIP LOCKED` for the transactional outbox,
and ARCHITECTURE.md 14 already requires that losing Redis lose no accepted
event. Given both, a separate queue is a second copy of state we are obliged to
keep in PostgreSQL anyway — and a second thing to reconcile after every crash.

The delivery row is written before any attempt is made, because that is what
makes replay and "did this endpoint ever receive it?" answerable. Once that row
exists, it *is* the work item.

## What it prevents

- **Lost in-flight deliveries when Redis restarts.** There is nothing in Redis
  to lose.
- **Split-brain between queue and ledger** — a job that exists in Redis but not
  in `deliveries`, or the reverse.
- **A recovery path that only exists on paper.** Crash recovery is the same
  query as normal operation: an expired lease is simply claimable again.

## How it scales

`SKIP LOCKED` on a partial index over due deliveries comfortably serves the
thousands-per-second range on modest hardware, and workers scale horizontally
without coordinating. The ceiling is write amplification on `deliveries` and
`delivery_attempts`, which arrives well after MVP and is answered first by
partitioning (ARCHITECTURE.md 35).

## Migration path

`queue.Queue` is the seam. A Redis or SQS implementation becomes a low-latency
*notification* layer in front of the same durable rows: the queue says "look
now", PostgreSQL still says what is true. Ordering of adoption should follow
measured claim latency, not fashion (engineering rule 23).
