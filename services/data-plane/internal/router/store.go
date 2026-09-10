package router

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/shaq/hookubit/services/data-plane/internal/ids"
)

// OutboxTypeEventCreated is the only outbox type the router handles. Ingest
// writes it in the same transaction as the event (ARCHITECTURE.md 15).
const OutboxTypeEventCreated = "event.created"

// maxErrorLength bounds what is written to event_outbox.last_error. Error text
// here is always a database error or one of this package's own reasons - never
// a payload and never a secret - but it is still truncated so one pathological
// message cannot bloat the table.
const maxErrorLength = 1000

// ErrFanOutTruncated reports that BuildPlan dropped targets it was handed.
//
// Under batched fan-out this is unreachable: the candidate query never returns
// more rows than the batch size, and deduplication only ever shrinks the target
// list, so the plan's own cap can never bite. It is checked anyway, and it
// FAILS THE TRANSACTION rather than committing, because the alternative is the
// bug this whole file was rewritten to remove: quietly committing a fan-out
// that reached fewer endpoints than it should have. A loud release is
// recoverable; a silent commit is not.
var ErrFanOutTruncated = errors.New("router: fan-out plan truncated targets; refusing to commit a partial fan-out")

// OutboxRow is a leased event_outbox row.
type OutboxRow struct {
	ID      string
	EventID string
	Type    string
	// Attempts is the value AFTER this claim incremented it, so the first claim
	// of a fresh row reports 1. It is MONOTONIC - nothing ever lowers it - so it
	// is the honest answer to "how many times has this been picked up?" in the
	// operator UI. It is NOT the poison bound; see UnaccountedAttempts.
	//
	// "Nothing" includes the control plane's operator requeue
	// (apps/control-api/src/outbox), which resets `unaccounted_attempts` and
	// `failing_since` - the two budgets - and deliberately leaves this alone.
	// Zeroing it would erase the one number that separates "this row has been
	// requeued four times and keeps dying" from "first time", which is the
	// question an operator asks before pressing the button again.
	Attempts int
	// UnaccountedAttempts is the poison bound, and it is a different number from
	// Attempts on purpose.
	//
	// Both are incremented by the committed claim, for the reason the claim SQL
	// gives: a row whose event kills the process never reaches a failure
	// handler, so an increment that only happened on failure would let it be
	// reclaimed and re-run forever. But this one is DECREMENTED by any write
	// this router commits under the lease - a recorded release, or a fan-out
	// batch that made progress.
	//
	// What survives is exactly "claims that ended with the router writing
	// nothing at all": a crash, an OOM, a lease left to lapse. That is the
	// poison signal. A degraded-Postgres window, where the router observes the
	// failure and records it, no longer spends the same budget - which is what
	// used to park an event that had already been answered with 202 Accepted.
	UnaccountedAttempts int
	// FanOutCursor is the subscription id the last committed batch stopped at.
	// Empty means the fan-out has not started. See Route.
	FanOutCursor string
	// FailingSince is when this row's first RECORDED failure since the last
	// progress happened, or nil if it is not currently failing. Recorded
	// failures are bounded by TIME rather than by count - see the router's
	// MaxOutboxRetryDuration - because no count can tell "the database was
	// unavailable for twenty minutes" from "this row always errors", and time
	// can.
	FailingSince *time.Time
	// TraceContext is the W3C `traceparent` of the INGEST request that
	// committed this row (ARCHITECTURE.md 44). Empty for a row written with
	// tracing off, or before the column existed; the router then starts an
	// unlinked root, so nothing here can change what is fanned out.
	TraceContext string
}

// Outcome is how one outbox row was resolved.
type Outcome string

const (
	// OutcomeRouted: deliveries were materialised and everything committed.
	OutcomeRouted Outcome = "routed"
	// OutcomeFanOutContinued: this batch of the fan-out committed and more
	// subscriptions remain. The event stays `processing`, the outbox row goes
	// back to the ready set immediately with its cursor advanced, and the next
	// claim resumes where this one stopped.
	OutcomeFanOutContinued Outcome = "fan_out_continued"
	// OutcomeNoSubscriptions: nothing matched. A normal, committed outcome -
	// the event is processed and the outbox row leaves the queue.
	OutcomeNoSubscriptions Outcome = "no_subscriptions"
	// OutcomeEventMissing: the outbox row points at an event that is gone.
	// Nothing was committed; the caller parks the row.
	OutcomeEventMissing Outcome = "event_missing"
	// OutcomeLeaseLost: another router owns this row now. Nothing was
	// committed; the other router will do the work.
	OutcomeLeaseLost Outcome = "lease_lost"
)

// RouteRequest is one unit of fan-out work.
type RouteRequest struct {
	RouterID string
	Row      OutboxRow
	// FanOutBatch bounds ONE TRANSACTION, not one event. It is how many
	// subscriptions are examined and how many deliveries are created by this
	// call; an event with more subscriptions than this takes several calls, each
	// resuming from the cursor the previous one committed.
	//
	// This is the whole of the fix for the truncation gap. The bound the cap
	// existed for - "one misconfigured project must not write an unbounded batch
	// inside a single transaction" - is preserved exactly. What is gone is the
	// bound on the TOTAL, which silently dropped every subscription past the cap
	// and had no recovery path, because replay is built on delivery rows and
	// those endpoints had none.
	FanOutBatch int

	// TraceContext is the W3C `traceparent` of the ROUTER's fan-out span,
	// stamped onto every delivery row this call creates. The worker reads it
	// and links each attempt to it (ARCHITECTURE.md 44).
	//
	// ONE value for the whole batch, not one per delivery. A per-delivery span
	// would mean ROUTER_MAX_SUBSCRIPTIONS_PER_EVENT spans per fan-out - up to
	// 2000 per transaction at the shipped default, for an event that has not
	// been delivered anywhere yet. The fan-out is one unit of work and gets one
	// span; the deliveries it creates all point at it, which is exactly what
	// "these N deliveries came from that fan-out" means.
	//
	// Empty writes NULL, which is what a delivery created with tracing off
	// carries.
	TraceContext string
}

// RouteResult reports what happened. Created is the number of delivery rows
// this transaction actually INSERTed: on a re-run of a partially applied batch
// it is legitimately lower than len(Plan.Targets), and on a full re-run it is
// zero.
type RouteResult struct {
	Outcome Outcome
	Event   Event
	Plan    Plan
	Created int
	// FanOutCursor is the subscription id this batch stopped at, committed onto
	// the outbox row when Outcome is OutcomeFanOutContinued.
	FanOutCursor string
}

// Store is the router's whole database surface.
//
// Route deliberately exposes no transaction handle. The atomicity of "insert
// the deliveries, advance the event, retire the outbox row" is the single most
// important property in this package, and an interface that let a caller split
// those three would be an interface that lets a caller break it.
type Store interface {
	// ClaimOutbox leases up to limit ready rows to routerID and moves their
	// events to `processing`.
	ClaimOutbox(ctx context.Context, routerID string, limit int, lease time.Duration) ([]OutboxRow, error)
	// Route performs one event's fan-out in a single transaction.
	Route(ctx context.Context, req RouteRequest) (RouteResult, error)
	// ParkOutbox retires a row as failed, with a recorded reason, and fails its
	// event. The row leaves the ready set permanently: a human decides what
	// happens next.
	ParkOutbox(ctx context.Context, routerID, outboxID, eventID, reason string) error
	// ReleaseOutbox returns a row to the ready set after retryAfter, recording
	// why. This is the transient-failure path.
	ReleaseOutbox(ctx context.Context, routerID, outboxID, reason string, retryAfter time.Duration) error
	// OutboxLagSeconds is the age of the oldest DUE unprocessed row.
	OutboxLagSeconds(ctx context.Context) (float64, error)
}

// PostgresStore is the production Store.
type PostgresStore struct {
	pool *pgxpool.Pool
}

func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore { return &PostgresStore{pool: pool} }

var _ Store = (*PostgresStore)(nil)

// claimOutboxSQL leases ready outbox rows.
//
// `processing` is in the status set for the same reason it is in the delivery
// queue's (see claimStatuses in internal/queue): a leased row is `processing`,
// so excluding it would make a crashed router's rows unreclaimable by any
// other router. The `locked_until IS NULL OR locked_until < now()` predicate is
// what actually decides claimability, evaluated inside FOR UPDATE SKIP LOCKED,
// so a live lease is never stolen.
//
// `failed` is NOT in the set. That status is the parking bay: a poisoned row
// sits there until a human looks at it, rather than cycling forever.
//
// BOTH attempt counters are incremented HERE, in the committed claim, not on
// the failure path. A row whose event kills the process - a pathological
// subscription set, an OOM on a huge fan-out - never reaches a failure handler,
// so an increment that only happened on failure would let it be reclaimed and
// re-run forever.
//
// They then diverge. `attempts` is monotonic and is what an operator reads.
// `unaccounted_attempts` is the poison bound, and every write this router
// commits under the lease gives one back - see releaseOutboxSQL and
// advanceFanOutSQL. So a claim that OBSERVED and RECORDED its failure costs
// nothing, and only a claim that vanished silently does. Before that split, a
// twenty-minute Postgres brownout burned all ten attempts on rows whose fan-out
// was never even tried, and parked events that had already been answered 202.
// The batch is fixed in a MATERIALIZED CTE before the UPDATE runs. The
// `WHERE id IN (SELECT ... LIMIT $3)` form this replaced can be planned with the
// subquery re-executed once per outer row, and LockRows then skips rows this
// same statement already updated, so a claim of $3 rows took every ready row.
// queue.claimFIFOSQL has the full account and the measurements.
const claimOutboxSQL = `
WITH picked AS MATERIALIZED (
    SELECT id AS picked_id
    FROM event_outbox
    WHERE status IN ('pending', 'processing')
      AND available_at <= now()
      AND (locked_until IS NULL OR locked_until < now())
    ORDER BY available_at, created_at, id
    FOR UPDATE SKIP LOCKED
    LIMIT $3
)
UPDATE event_outbox o
SET status               = 'processing',
    attempts             = o.attempts + 1,
    unaccounted_attempts = o.unaccounted_attempts + 1,
    locked_by            = $1,
    locked_until         = now() + $2::interval
FROM picked
WHERE o.id = picked.picked_id
RETURNING o.id, o.event_id, o.type, o.attempts, o.unaccounted_attempts,
          COALESCE(o.fan_out_cursor, ''), o.failing_since,
          COALESCE(o.trace_context, '')`

// markEventsProcessingSQL is the `received -> processing` half of the event
// state machine (ARCHITECTURE.md 19). It runs in the claim transaction so the
// operator UI shows an event as in-flight for exactly as long as it is, and so
// a re-claim after a crash is idempotent (the row is already `processing`).
const markEventsProcessingSQL = `
UPDATE events
SET status = 'processing'
WHERE id = ANY($1::text[])
  AND status = 'received'`

func (s *PostgresStore) ClaimOutbox(
	ctx context.Context, routerID string, limit int, lease time.Duration,
) ([]OutboxRow, error) {
	if limit <= 0 {
		return nil, fmt.Errorf("claim limit must be positive")
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin outbox claim: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, claimOutboxSQL, routerID, intervalOf(lease), limit)
	if err != nil {
		return nil, fmt.Errorf("claim outbox rows: %w", err)
	}
	var claimed []OutboxRow
	for rows.Next() {
		var r OutboxRow
		if err := rows.Scan(&r.ID, &r.EventID, &r.Type, &r.Attempts,
			&r.UnaccountedAttempts, &r.FanOutCursor, &r.FailingSince,
			&r.TraceContext); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan claimed outbox row: %w", err)
		}
		claimed = append(claimed, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate claimed outbox rows: %w", err)
	}
	if len(claimed) == 0 {
		// Nothing to commit, but the transaction still has to end.
		return nil, tx.Commit(ctx)
	}

	eventIDs := make([]string, 0, len(claimed))
	for _, r := range claimed {
		eventIDs = append(eventIDs, r.EventID)
	}
	if _, err := tx.Exec(ctx, markEventsProcessingSQL, eventIDs); err != nil {
		return nil, fmt.Errorf("mark events processing: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit outbox claim: %w", err)
	}
	return claimed, nil
}

// loadEventSQL reads the routing inputs only. The payload is never loaded: the
// router decides destinations, and pulling a 1 MB body through this path to
// throw it away would make fan-out cost scale with payload size.
//
// ordering_key falls back to the headers JSON because ingest still writes it
// there (see requestMetadata in internal/ingest); the dedicated column landed
// later. COALESCE means this keeps working whichever side migrates first.
//
// created_at is loaded because it is the fan-out's PIN: it decides which
// subscriptions this event is entitled to reach, whatever has happened to the
// project since. See loadCandidatesSQL.
const loadEventSQL = `
SELECT e.id, e.organization_id, e.project_id, e.event_type,
       COALESCE(e.ordering_key, e.headers->>'ordering_key', ''),
       e.created_at
FROM events e
WHERE e.id = $1`

// loadCandidatesSQL reads every subscription in the event's project together
// with the endpoint, project, organisation and retry policy that gate it.
//
// It does NOT filter on enabled/status. BuildPlan does that, so the router can
// report WHY a subscription was skipped rather than silently returning fewer
// rows - see the comment on Candidate.
//
// The tenant columns come from the endpoint's own project and organisation, not
// from the event, so BuildPlan can reject a subscription that crosses a tenant
// boundary instead of stamping the event's tenant onto it.
//
// `s.id > $2` is the RESUME POINT, and it is why this query is safe to run
// several times for one event. It is a keyset walk, not an OFFSET: the router
// never re-reads a page it has already materialised, and a subscription deleted
// mid-walk cannot shift the window and skip its neighbour. `ORDER BY s.id` was
// already here; ids are ULIDs, so the walk is oldest-subscription-first and
// deterministic. `$2` is the empty string on the first batch, which sorts below
// every ULID.
//
// `s.created_at <= $3` PINS THE SUBSCRIPTION SET TO PUBLISH TIME, and it is
// what stops the keyset walk from changing who receives an event.
//
// A batched fan-out spans several transactions and therefore several snapshots.
// Without this predicate: an event is accepted at 09:59 and batch 1 commits, a
// customer creates a subscription at 10:00 whose ULID sorts after the committed
// cursor, and batch 2 at 10:01 hands that subscription a delivery for an event
// published before it existed. For any project narrower than the batch size it
// cannot happen at all - one batch, one snapshot - so the observable rule was
// "you receive events published before you subscribed IF your project happens
// to have more subscriptions than ROUTER_MAX_SUBSCRIPTIONS_PER_EVENT". Nobody
// can reason about that, least of all the customer it happens to.
//
// The pin makes the answer the same for every project and for every width:
// an event reaches the subscriptions that existed when it was ACCEPTED. That is
// the same set the first batch already saw, so the wide case now agrees with
// the narrow one rather than the other way round.
//
// Both columns are timestamp(3), so a subscription created in the same
// millisecond as the event compares equal and is INCLUDED. The boundary is
// deliberately forgiving in that direction: at publish time the subscription
// existed, and dropping it would be the failure mode this file exists to
// remove.
//
// What this does NOT change is the walk itself: the cursor still only moves
// forward, a subscription deleted mid-walk still cannot shift the window, and a
// row whose id sorts below a cursor the walk has already passed is still not
// re-read. The pin narrows WHICH rows are eligible; it does not reorder them.
//
// LIMIT bounds ONE TRANSACTION. It is batch+1 so the caller can tell "this was
// the last page" from "there is more", without a second COUNT.
const loadCandidatesSQL = `
SELECT s.id,
       s.endpoint_id,
       COALESCE(s.event_types, ARRAY[]::text[]),
       s.enabled,
       ep.project_id,
       p.organization_id,
       ep.status::text,
       ep.enabled,
       p.status::text,
       o.status::text,
       COALESCE(rp.max_attempts, 0),
       COALESCE(dp.max_attempts, 0)
FROM webhook_subscriptions s
JOIN endpoints ep    ON ep.id = s.endpoint_id
JOIN projects p      ON p.id  = ep.project_id
JOIN organizations o ON o.id  = p.organization_id
LEFT JOIN retry_policies rp ON rp.id = ep.retry_policy_id
LEFT JOIN LATERAL (
    SELECT r.max_attempts
    FROM retry_policies r
    WHERE r.project_id = p.id AND r.is_default
    ORDER BY r.created_at, r.id
    LIMIT 1
) dp ON true
WHERE s.project_id = $1
  AND s.id > $2
  AND s.created_at <= $3
ORDER BY s.id
LIMIT $4`

// insertDeliveriesSQL materialises the fan-out.
//
// THE CONFLICT TARGET IS THE POINT OF THIS FILE. The arbiter is the PARTIAL
// unique index deliveries_event_endpoint_original_key, and PostgreSQL will only
// select a partial index for inference if the statement repeats its predicate
// verbatim - hence the `WHERE replay_of_delivery_id IS NULL` after the conflict
// target. Drop it and this statement fails at runtime with "there is no unique
// or exclusion constraint matching the ON CONFLICT specification"; get it wrong
// and a re-run after a crash delivers every webhook twice. The index is partial
// because replay legitimately creates a second row for the same
// (event_id, endpoint_id) pair, carrying replay_of_delivery_id.
//
// next_attempt_at is written explicitly as now(). The column is NOT NULL with
// that same default (20260911000000), and the queue orders by it, so a brand-new
// delivery is due the moment it exists. It is spelled out rather than left to
// the default so the value's meaning is in this statement, next to the claim
// predicate it is compared against - and because, while the column was nullable
// and the claim ordered NULLS FIRST, a NULL here sorted every brand-new delivery
// ahead of every due retry: under sustained ingest a retry starved until it hit
// max_retry_duration and was reported to the customer as their endpoint failing
// when the platform never re-attempted it. The constraint rejects that write
// now; this comment is why it exists.
//
// organization_id and project_id are copied from the EVENT, which is the tenant
// the event was accepted under. They are what the control plane's listing
// queries filter on, so a wrong value here is a cross-tenant leak, not a
// cosmetic denormalisation.
//
// updated_at is written explicitly: Prisma's @updatedAt is application-side, so
// the column is NOT NULL with no database default.
//
// 'pending' carries an EXPLICIT cast to the enum type. In an INSERT ... SELECT
// (unlike INSERT ... VALUES) PostgreSQL resolves the subquery's unknown-typed
// literals to `text` before it looks at the target columns, and there is no
// assignment cast from text to an enum - so the bare literal fails at runtime
// with "column status is of type DeliveryStatus but expression is of type
// text". The quoted type name is Prisma's; it is fixed by the migration.
const insertDeliveriesSQL = `
INSERT INTO deliveries (
    id, event_id, endpoint_id, subscription_id,
    organization_id, project_id,
    status, attempt_count, max_attempts,
    next_attempt_at, ordering_key,
    created_at, updated_at, trace_context
)
SELECT t.id, $1::text, t.endpoint_id, t.subscription_id,
       $2::text, $3::text,
       'pending'::"DeliveryStatus", 0, t.max_attempts,
       -- next_attempt_at. NOTE: this column is timestamp(3) and the claim
       -- predicate compares next_attempt_at <= now(), so storing a bare now()
       -- rounds UP about half the time by up to 0.5ms and the row is briefly
       -- invisible. Harmless here - the worker polls every 250ms, so the row
       -- is claimed on the same cycle - but it is the same rounding that made
       -- an outbox test fail 1 in 10, so it is worth knowing it exists.
       now(), $4::text,
       -- created_at, updated_at, trace_context. The trace context is one value
       -- for the whole batch: the fan-out is one unit of work with one span,
       -- and every delivery it creates links back to that span.
       now(), now(), $9::text
FROM unnest($5::text[], $6::text[], $7::text[], $8::int[])
     AS t(id, endpoint_id, subscription_id, max_attempts)
ON CONFLICT (event_id, endpoint_id) WHERE replay_of_delivery_id IS NULL
DO NOTHING
RETURNING id`

// markEventProcessedSQL closes the event state machine. The status guard keeps
// a re-run from rewriting processed_at, so the timestamp means "when the
// fan-out first committed".
//
// It runs ONLY on the batch that exhausts the subscription list. An event whose
// fan-out is still in flight stays `processing`, which is the truth: `processed`
// is a claim that the system delivered what it accepted, and it must not be
// made while endpoints are still waiting for their delivery rows.
const markEventProcessedSQL = `
UPDATE events
SET status = 'processed', processed_at = now()
WHERE id = $1 AND status <> 'processed'`

// markOutboxProcessedSQL retires the row, and the locked_by guard is what makes
// the whole transaction safe under a lost lease. If our lease expired and
// another router claimed the row, this affects zero rows and the caller rolls
// back - including the deliveries. Without the guard we would retire a row we
// no longer own and race the other router over the same fan-out.
// The failure bookkeeping is cleared alongside last_error, for the same reason
// last_error was already cleared: this row succeeded, and a retired row that
// still reads "one unaccounted claim, failing since 09:14" invites an operator
// to investigate a fan-out that completed.
const markOutboxProcessedSQL = `
UPDATE event_outbox
SET status               = 'processed',
    processed_at         = now(),
    locked_by            = NULL,
    locked_until         = NULL,
    last_error           = NULL,
    failing_since        = NULL,
    unaccounted_attempts = 0
WHERE id = $1 AND locked_by = $2`

// advanceFanOutSQL commits PROGRESS on a fan-out that is not finished.
//
// It is the other half of markOutboxProcessedSQL and carries the same
// `locked_by` guard, for the same reason: if the lease lapsed and another
// router took the row, this affects zero rows and the caller rolls the whole
// transaction back - deliveries included - rather than two routers advancing
// one cursor over each other.
//
// The row goes straight back to the ready set (`available_at = now()`), so the
// next poll resumes it. It sorts behind everything already due, which is the
// fairness property that keeps one 10,000-subscription event from monopolising
// the queue: it takes its turn per batch rather than holding one transaction
// open for the whole fan-out.
//
// `unaccounted_attempts` gives one back and `failing_since` is cleared. This
// claim demonstrably did work and recorded it, so it is not evidence of a
// poisoned row, and progress means the row is not "still failing" however many
// transient errors preceded it. Without the refund a large fan-out would spend
// its own poison budget one batch at a time and park itself.
//
// available_at is date_trunc'd, not a bare now(). `available_at` is
// timestamp(3) and PostgreSQL ROUNDS to that precision - measured on this
// database, 1050 of 2000 microsecond timestamps stored AHEAD of the clock that
// wrote them - while the claim predicate is `available_at <= now()`. A bare
// now() therefore makes a row that is supposed to be immediately claimable
// invisible for up to 0.5ms about half the time. In production that is
// invisible behind a 250ms poll; the reason to fix it here rather than shrug is
// that "immediately claimable" is the whole contract of this statement, and a
// claim issued in the same millisecond - which is what a drain loop and a
// second router replica both do - is entitled to see the row. date_trunc floors
// instead of rounding, so the stored value can never be ahead of the write.
// This is the same rounding hazard the note on insertDeliveriesSQL describes.
const advanceFanOutSQL = `
UPDATE event_outbox
SET status               = 'pending',
    available_at         = date_trunc('milliseconds', now()),
    fan_out_cursor       = $3,
    locked_by            = NULL,
    locked_until         = NULL,
    last_error           = NULL,
    failing_since        = NULL,
    unaccounted_attempts = GREATEST(unaccounted_attempts - 1, 0)
WHERE id = $1 AND locked_by = $2`

// Route materialises ONE BATCH of an event's fan-out.
//
// The batch is the unit of atomicity, not the event. For an event within
// req.FanOutBatch subscriptions - which is every normal event - that is exactly
// the old behaviour: one transaction inserts the deliveries, marks the event
// `processed` and retires the outbox row. Beyond it, the transaction commits
// what it wrote, advances a durable cursor and hands the row back to the queue.
//
// Committing a partial fan-out is safe because of the partial unique index
// `deliveries_event_endpoint_original_key (event_id, endpoint_id) WHERE
// replay_of_delivery_id IS NULL`: every insert here is already idempotent per
// (event, endpoint), so a crash between batches re-runs at worst one batch and
// creates nothing twice.
//
// It is also observable: an event mid-fan-out reads `processing`, not
// `processed`, and its outbox row carries the cursor.
//
// The trade-off, stated plainly: a wide fan-out is no longer one atomic write,
// so the endpoints in batch 1 start receiving the event while batch 2 is still
// being materialised. At-least-once delivery and unenforced ordering (ADR-0004)
// both already permit that, and the alternative it replaces is that the
// endpoints past the cap NEVER received the event and no API could reach them.
func (s *PostgresStore) Route(ctx context.Context, req RouteRequest) (RouteResult, error) {
	var res RouteResult

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return res, fmt.Errorf("begin route transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var ev Event
	err = tx.QueryRow(ctx, loadEventSQL, req.Row.EventID).Scan(
		&ev.ID, &ev.OrganizationID, &ev.ProjectID, &ev.EventType, &ev.OrderingKey,
		&ev.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		// The outbox row outlived its event. Nothing to fan out, ever.
		res.Outcome = OutcomeEventMissing
		return res, nil
	}
	if err != nil {
		return res, fmt.Errorf("load event %s: %w", req.Row.EventID, err)
	}
	res.Event = ev

	batch := req.FanOutBatch
	if batch <= 0 {
		batch = DefaultFanOutBatch
	}
	// ev.CreatedAt, not now(): every batch of this event's fan-out is measured
	// against the same instant, so batch 7 sees the subscription set batch 1
	// saw. See loadCandidatesSQL.
	candidates, more, err := s.loadCandidates(
		ctx, tx, ev.ProjectID, req.Row.FanOutCursor, ev.CreatedAt, batch)
	if err != nil {
		return res, err
	}

	// BuildPlan is handed the batch as its own cap purely as a belt-and-braces
	// bound; `candidates` is already at most `batch` long and deduplication only
	// shrinks the target list, so it can never bite. If it somehow does, that is
	// a plan silently smaller than its inputs - the exact failure this rewrite
	// removed - and it fails the transaction rather than committing.
	plan := BuildPlan(ev, candidates, batch)
	res.Plan = plan
	if plan.Truncated > 0 {
		return res, fmt.Errorf("%w: event %s dropped %d of %d targets",
			ErrFanOutTruncated, ev.ID, plan.Truncated, len(plan.Targets)+plan.Truncated)
	}

	if len(plan.Targets) > 0 {
		created, err := insertDeliveries(ctx, tx, ev, plan.Targets, req.TraceContext)
		if err != nil {
			return res, err
		}
		res.Created = created
	}

	if more {
		// The cursor is the last subscription this batch CONSIDERED, not the
		// last one it delivered to. A batch made entirely of disabled or
		// unmatched subscriptions still has to advance, or the walk stalls on
		// them forever.
		res.FanOutCursor = candidates[len(candidates)-1].SubscriptionID
		tag, err := tx.Exec(ctx, advanceFanOutSQL, req.Row.ID, req.RouterID, res.FanOutCursor)
		if err != nil {
			return res, fmt.Errorf("advance fan-out cursor for outbox row %s: %w", req.Row.ID, err)
		}
		if tag.RowsAffected() == 0 {
			res.Outcome = OutcomeLeaseLost
			return res, nil
		}
		if err := tx.Commit(ctx); err != nil {
			return res, fmt.Errorf("commit fan-out batch: %w", err)
		}
		res.Outcome = OutcomeFanOutContinued
		return res, nil
	}

	if _, err := tx.Exec(ctx, markEventProcessedSQL, ev.ID); err != nil {
		return res, fmt.Errorf("mark event %s processed: %w", ev.ID, err)
	}

	tag, err := tx.Exec(ctx, markOutboxProcessedSQL, req.Row.ID, req.RouterID)
	if err != nil {
		return res, fmt.Errorf("mark outbox row %s processed: %w", req.Row.ID, err)
	}
	if tag.RowsAffected() == 0 {
		// Our lease is gone. Roll the whole transaction back - deliveries
		// included - and let whoever owns the row now do the work.
		res.Outcome = OutcomeLeaseLost
		return res, nil
	}

	if err := tx.Commit(ctx); err != nil {
		return res, fmt.Errorf("commit route transaction: %w", err)
	}

	// "Nothing matched" is only true of an event whose WHOLE subscription list
	// was walked and produced nothing. A final batch that matched nothing after
	// earlier batches created deliveries is a routed event, and reporting it as
	// no_subscriptions would put a misleading line in the log an operator reads
	// to answer "why did nothing arrive?".
	if len(plan.Targets) == 0 && req.Row.FanOutCursor == "" {
		res.Outcome = OutcomeNoSubscriptions
	} else {
		res.Outcome = OutcomeRouted
	}
	return res, nil
}

// loadCandidates reads one page of the project's subscriptions, starting after
// cursor and bounded to those that existed at publishedAt. `more` reports that
// the page was full and another one exists.
func (s *PostgresStore) loadCandidates(
	ctx context.Context, tx pgx.Tx, projectID, cursor string, publishedAt time.Time, batch int,
) ([]Candidate, bool, error) {
	rows, err := tx.Query(ctx, loadCandidatesSQL, projectID, cursor, publishedAt, batch+1)
	if err != nil {
		return nil, false, fmt.Errorf("load subscriptions for project %s: %w", projectID, err)
	}
	defer rows.Close()

	var candidates []Candidate
	for rows.Next() {
		var c Candidate
		if err := rows.Scan(
			&c.SubscriptionID, &c.EndpointID, &c.EventTypes, &c.Enabled,
			&c.EndpointProjectID, &c.EndpointOrganizationID,
			&c.EndpointStatus, &c.EndpointEnabled,
			&c.ProjectStatus, &c.OrganizationStatus,
			&c.EndpointMaxAttempts, &c.ProjectDefaultMaxAttempts,
		); err != nil {
			return nil, false, fmt.Errorf("scan subscription: %w", err)
		}
		candidates = append(candidates, c)
	}
	if err := rows.Err(); err != nil {
		return nil, false, fmt.Errorf("iterate subscriptions: %w", err)
	}

	// The +1th row is a probe: it proves another page exists and is discarded,
	// so it is never materialised twice.
	more := len(candidates) > batch
	if more {
		candidates = candidates[:batch]
	}
	return candidates, more, nil
}

func insertDeliveries(ctx context.Context, tx pgx.Tx, ev Event, targets []Target, traceContext string) (int, error) {
	deliveryIDs := make([]string, len(targets))
	endpointIDs := make([]string, len(targets))
	subscriptionIDs := make([]string, len(targets))
	maxAttempts := make([]int32, len(targets))
	for i, t := range targets {
		deliveryIDs[i] = ids.New(ids.Delivery)
		endpointIDs[i] = t.EndpointID
		subscriptionIDs[i] = t.SubscriptionID
		maxAttempts[i] = int32(t.MaxAttempts)
	}

	var orderingKey any
	if ev.OrderingKey != "" {
		// Stored, never enforced (ADR-0004). It is here so that turning
		// ordering on later is a change to the claim query, not a backfill of
		// the largest table in the system.
		orderingKey = ev.OrderingKey
	}

	var trace any
	if traceContext != "" {
		trace = traceContext
	}

	rows, err := tx.Query(ctx, insertDeliveriesSQL,
		ev.ID, ev.OrganizationID, ev.ProjectID, orderingKey,
		deliveryIDs, endpointIDs, subscriptionIDs, maxAttempts, trace,
	)
	if err != nil {
		return 0, fmt.Errorf("insert deliveries for event %s: %w", ev.ID, err)
	}
	defer rows.Close()

	created := 0
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return 0, fmt.Errorf("scan created delivery: %w", err)
		}
		created++
	}
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("iterate created deliveries: %w", err)
	}
	return created, nil
}

// parkOutboxSQL removes a row from the queue permanently. processed_at is set
// so a retention sweep can find parked rows by age; status `failed` is what
// keeps them out of claimOutboxSQL's ready set.
const parkOutboxSQL = `
UPDATE event_outbox
SET status       = 'failed',
    processed_at = now(),
    locked_by    = NULL,
    locked_until = NULL,
    last_error   = $3
WHERE id = $1 AND locked_by = $2`

// failEventSQL is the `processing -> failed` transition. The guard leaves an
// already-processed event alone: a second outbox row for an event that was
// routed successfully must not undo that.
const failEventSQL = `
UPDATE events
SET status = 'failed', processed_at = now()
WHERE id = $1 AND status <> 'processed'`

func (s *PostgresStore) ParkOutbox(ctx context.Context, routerID, outboxID, eventID, reason string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin park transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx, parkOutboxSQL, outboxID, routerID, truncateError(reason))
	if err != nil {
		return fmt.Errorf("park outbox row %s: %w", outboxID, err)
	}
	if tag.RowsAffected() == 0 {
		// Someone else owns it; leave their bookkeeping alone.
		return ErrLeaseLost
	}
	if eventID != "" {
		if _, err := tx.Exec(ctx, failEventSQL, eventID); err != nil {
			return fmt.Errorf("fail event %s: %w", eventID, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit park transaction: %w", err)
	}
	return nil
}

// releaseOutboxSQL returns a row to the ready set after a backoff. The event is
// deliberately left in `processing`: it IS still being processed, and flapping
// it back to `received` would make the operator UI lie about every transient
// database blip.
//
// Two bookkeeping columns make this the RECORDED-failure path, as distinct from
// a claim that simply vanished:
//
//   - `unaccounted_attempts` gives one back. This statement is the proof that
//     the router survived the failure, saw what it was and wrote it down, so
//     the claim is not evidence of a poisoned row. Reaching this statement is
//     what the refund is FOR; a crash never reaches it, and that row keeps its
//     increment and eventually parks.
//   - `failing_since` starts the clock (COALESCE, so it marks the FIRST failure
//     in the current run, not the latest). Recorded failures are bounded by
//     elapsed time rather than by a count - see MaxOutboxRetryDuration - because
//     a count cannot tell a database outage from a broken row and a clock can:
//     an outage ends, a broken row does not.
//
// GREATEST(...,0) rather than a bare subtraction: the refund must never be able
// to drive the counter negative and hand a genuinely poisoned row an unbounded
// budget, however this statement is reached.
//
// available_at is floored to the column's timestamp(3) precision rather than
// left to round, for the reason advanceFanOutSQL gives: rounding can only ever
// push the row LATER than the schedule says, and "available at T" should mean
// claimable at T. It is half a millisecond on a backoff measured in seconds, so
// it changes nothing in production - but it makes a zero backoff mean "now",
// which is the only value where the difference is observable.
const releaseOutboxSQL = `
UPDATE event_outbox
SET status               = 'pending',
    available_at         = date_trunc('milliseconds', now() + $3::interval),
    locked_by            = NULL,
    locked_until         = NULL,
    last_error           = $4,
    failing_since        = COALESCE(failing_since, now()),
    unaccounted_attempts = GREATEST(unaccounted_attempts - 1, 0)
WHERE id = $1 AND locked_by = $2`

func (s *PostgresStore) ReleaseOutbox(
	ctx context.Context, routerID, outboxID, reason string, retryAfter time.Duration,
) error {
	if retryAfter < 0 {
		retryAfter = 0
	}
	tag, err := s.pool.Exec(ctx, releaseOutboxSQL,
		outboxID, routerID, intervalOf(retryAfter), truncateError(reason))
	if err != nil {
		return fmt.Errorf("release outbox row %s: %w", outboxID, err)
	}
	if tag.RowsAffected() == 0 {
		return ErrLeaseLost
	}
	return nil
}

// outboxLagSQL measures the oldest DUE unprocessed row, not the oldest
// unprocessed row. A row sitting in its backoff window is not lag - counting it
// would make every transient failure look like the router falling behind.
//
// available_at rather than created_at because event_outbox_status_available_at_idx
// makes the MIN an index descent instead of a scan; for a row that has never
// been retried the two are the same value.
const outboxLagSQL = `
SELECT COALESCE(EXTRACT(EPOCH FROM (now() - MIN(available_at))), 0)::double precision
FROM event_outbox
WHERE status IN ('pending', 'processing')
  AND available_at <= now()`

func (s *PostgresStore) OutboxLagSeconds(ctx context.Context) (float64, error) {
	var seconds float64
	if err := s.pool.QueryRow(ctx, outboxLagSQL).Scan(&seconds); err != nil {
		return 0, fmt.Errorf("measure outbox lag: %w", err)
	}
	if seconds < 0 {
		seconds = 0
	}
	return seconds, nil
}

func intervalOf(d time.Duration) string {
	return fmt.Sprintf("%d milliseconds", d.Milliseconds())
}

func truncateError(s string) string {
	if len(s) <= maxErrorLength {
		return s
	}
	return s[:maxErrorLength-3] + "..."
}
