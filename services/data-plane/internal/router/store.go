package router

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/shaq/webhook-platform/services/data-plane/internal/ids"
)

// OutboxTypeEventCreated is the only outbox type the router handles. Ingest
// writes it in the same transaction as the event (ARCHITECTURE.md 15).
const OutboxTypeEventCreated = "event.created"

// maxErrorLength bounds what is written to event_outbox.last_error. Error text
// here is always a database error or one of this package's own reasons - never
// a payload and never a secret - but it is still truncated so one pathological
// message cannot bloat the table.
const maxErrorLength = 1000

// OutboxRow is a leased event_outbox row.
type OutboxRow struct {
	ID      string
	EventID string
	Type    string
	// Attempts is the value AFTER this claim incremented it, so the first claim
	// of a fresh row reports 1. Incrementing at claim time rather than at
	// failure time is what bounds a row that kills the process before it can
	// record anything: the increment is already committed.
	Attempts int
}

// Outcome is how one outbox row was resolved.
type Outcome string

const (
	// OutcomeRouted: deliveries were materialised and everything committed.
	OutcomeRouted Outcome = "routed"
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
	// FanOutCap bounds both the subscriptions examined and the deliveries
	// created for this event.
	FanOutCap int
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
	// CandidatesTruncated reports that the subscription query hit its own
	// bound, so subscriptions beyond the cap were never even considered.
	CandidatesTruncated bool
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
// attempts is incremented HERE, in the committed claim, not on the failure
// path. A row whose event kills the process - a pathological subscription set,
// an OOM on a huge fan-out - never reaches a failure handler, so an increment
// that only happened on failure would let it be reclaimed and re-run forever.
const claimOutboxSQL = `
UPDATE event_outbox o
SET status       = 'processing',
    attempts     = o.attempts + 1,
    locked_by    = $1,
    locked_until = now() + $2::interval
WHERE o.id IN (
    SELECT id
    FROM event_outbox
    WHERE status IN ('pending', 'processing')
      AND available_at <= now()
      AND (locked_until IS NULL OR locked_until < now())
    ORDER BY available_at, created_at
    FOR UPDATE SKIP LOCKED
    LIMIT $3
)
RETURNING o.id, o.event_id, o.type, o.attempts`

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
		if err := rows.Scan(&r.ID, &r.EventID, &r.Type, &r.Attempts); err != nil {
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
const loadEventSQL = `
SELECT e.id, e.organization_id, e.project_id, e.event_type,
       COALESCE(e.ordering_key, e.headers->>'ordering_key', '')
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
// LIMIT bounds the work one event can cause. It is cap+1 so the caller can tell
// "exactly at the cap" from "over it" and log loudly.
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
ORDER BY s.id
LIMIT $2`

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
// next_attempt_at is set to now() rather than left NULL. The delivery queue
// orders by `next_attempt_at NULLS FIRST`, so a NULL here would sort every
// brand-new delivery ahead of every due retry: under sustained ingest a retry
// starves until it hits max_retry_duration and is reported to the customer as
// their endpoint failing when the platform never re-attempted it.
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
    created_at, updated_at
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
       now(), now()
FROM unnest($5::text[], $6::text[], $7::text[], $8::int[])
     AS t(id, endpoint_id, subscription_id, max_attempts)
ON CONFLICT (event_id, endpoint_id) WHERE replay_of_delivery_id IS NULL
DO NOTHING
RETURNING id`

// markEventProcessedSQL closes the event state machine. The status guard keeps
// a re-run from rewriting processed_at, so the timestamp means "when the
// fan-out first committed".
const markEventProcessedSQL = `
UPDATE events
SET status = 'processed', processed_at = now()
WHERE id = $1 AND status <> 'processed'`

// markOutboxProcessedSQL retires the row, and the locked_by guard is what makes
// the whole transaction safe under a lost lease. If our lease expired and
// another router claimed the row, this affects zero rows and the caller rolls
// back - including the deliveries. Without the guard we would retire a row we
// no longer own and race the other router over the same fan-out.
const markOutboxProcessedSQL = `
UPDATE event_outbox
SET status       = 'processed',
    processed_at = now(),
    locked_by    = NULL,
    locked_until = NULL,
    last_error   = NULL
WHERE id = $1 AND locked_by = $2`

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

	fanOutCap := req.FanOutCap
	if fanOutCap <= 0 {
		fanOutCap = DefaultMaxSubscriptionsPerEvent
	}
	candidates, truncated, err := s.loadCandidates(ctx, tx, ev.ProjectID, fanOutCap)
	if err != nil {
		return res, err
	}
	res.CandidatesTruncated = truncated

	plan := BuildPlan(ev, candidates, fanOutCap)
	res.Plan = plan

	if len(plan.Targets) > 0 {
		created, err := insertDeliveries(ctx, tx, ev, plan.Targets)
		if err != nil {
			return res, err
		}
		res.Created = created
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

	if len(plan.Targets) == 0 {
		res.Outcome = OutcomeNoSubscriptions
	} else {
		res.Outcome = OutcomeRouted
	}
	return res, nil
}

func (s *PostgresStore) loadCandidates(
	ctx context.Context, tx pgx.Tx, projectID string, fanOutCap int,
) ([]Candidate, bool, error) {
	rows, err := tx.Query(ctx, loadCandidatesSQL, projectID, fanOutCap+1)
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

	truncated := len(candidates) > fanOutCap
	if truncated {
		candidates = candidates[:fanOutCap]
	}
	return candidates, truncated, nil
}

func insertDeliveries(ctx context.Context, tx pgx.Tx, ev Event, targets []Target) (int, error) {
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

	rows, err := tx.Query(ctx, insertDeliveriesSQL,
		ev.ID, ev.OrganizationID, ev.ProjectID, orderingKey,
		deliveryIDs, endpointIDs, subscriptionIDs, maxAttempts,
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
const releaseOutboxSQL = `
UPDATE event_outbox
SET status       = 'pending',
    available_at = now() + $3::interval,
    locked_by    = NULL,
    locked_until = NULL,
    last_error   = $4
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
