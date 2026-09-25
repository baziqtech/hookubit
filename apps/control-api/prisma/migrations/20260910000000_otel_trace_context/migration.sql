-- ---------------------------------------------------------------------------
-- W3C trace context, carried through PostgreSQL (ARCHITECTURE.md 44).
--
-- WHY A COLUMN AND NOT AN IN-PROCESS CONTEXT.
--
-- A webhook crosses three ASYNCHRONOUS process boundaries, each of them a
-- database write and an arbitrary amount of time apart:
--
--     ingest (COMMIT event + outbox row, 202)
--       -> router (claim the outbox row, materialise the fan-out)
--            -> worker (claim the delivery, sign, POST)
--
-- Nothing in-process survives those boundaries. There is no goroutine, no
-- channel and no request context linking the 202 a customer received at 09:00
-- to the retry that finally succeeded at 15:00 on a different pod. The only
-- thing that does survive is the row, so the row carries the context.
--
-- WHICH ROWS, AND WHY NOT `events`.
--
--   event_outbox.trace_context    written by ingest, read by the router
--   deliveries.trace_context      written by the router, read by the worker
--   delivery_attempts.trace_id    written by the worker, read by a human
--
-- `events` gets nothing. It is the durable record of what the publisher SENT;
-- the trace context is a property of the WORK, and the work is claimed from the
-- outbox. An event replayed months later is new work with a new cause, and
-- stamping the original request's trace context on it would attribute a 2026
-- replay to a 2025 HTTP request. Keeping it off `events` also keeps this
-- migration off the one table that carries payload bytes.
--
-- `deliveries` carries its own rather than inheriting the event's because a
-- delivery is a SEPARATE RETRY CHAIN from its event: one event becomes N
-- deliveries, each of which lives, fails and is retried independently, and each
-- of which is a different question an operator asks.
--
-- WHAT THE VALUES ARE.
--
-- trace_context is one W3C `traceparent`: a FIXED 55 characters, shaped
-- `00-<32 hex trace id>-<16 hex span id>-<2 hex flags>`. `tracestate` is
-- deliberately NOT stored - it is vendor-specific, unbounded in length, and
-- nothing in this platform sets it, so storing an unbounded string on the
-- hottest tables to preserve a field we do not use is not a trade worth making.
--
-- delivery_attempts.trace_id is the 32-character trace id of the span for THAT
-- attempt, and it is written ONLY when the span was actually sampled. A trace
-- id for a span that was dropped would put a link in the operator UI that leads
-- to an empty page, which is worse than no link: the operator concludes the
-- trace backend is broken rather than that this attempt was not recorded. NULL
-- therefore means "no trace was kept for this attempt", honestly.
--
-- NULLABLE, WITH NO DEFAULT, ON PURPOSE. Tracing is off unless
-- OTEL_EXPORTER_OTLP_ENDPOINT is set, every row written before this migration
-- has no context, and the data plane treats absent and unparseable identically:
-- the stage starts an unlinked root. Nothing in the delivery path branches on
-- these columns being present, so a NULL can never change what is delivered.
--
-- SAFE ON A POPULATED TABLE. Adding a NULLABLE column with no default is a
-- catalogue-only change on PostgreSQL 11+: no table rewrite, and an ACCESS
-- EXCLUSIVE lock held only for a catalogue update. It is still a lock on the
-- three hottest tables in the system, so it will queue behind a long-running
-- transaction. On a large installation, run each statement by hand first with
--
--     SET lock_timeout = '5s';
--
-- and let this migration find the columns already present and do nothing.
--
-- NO INDEXES. These columns are never a predicate. Nothing in either plane
-- queries "find the rows with this trace id" - the trace backend is that index,
-- and it is the one that knows about sampling and retention. Indexing 55 bytes
-- of high-cardinality text on `deliveries` would be pure write cost on the
-- fan-out path for a query nobody issues.
-- ---------------------------------------------------------------------------

ALTER TABLE "event_outbox"
    ADD COLUMN IF NOT EXISTS "trace_context" TEXT;

ALTER TABLE "deliveries"
    ADD COLUMN IF NOT EXISTS "trace_context" TEXT;

ALTER TABLE "delivery_attempts"
    ADD COLUMN IF NOT EXISTS "trace_id" TEXT;
