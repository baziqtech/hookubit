package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/shaq/webhook-platform/services/data-plane/internal/ids"
	"github.com/shaq/webhook-platform/services/data-plane/internal/retry"
)

// ErrDeliveryGone reports that the delivery row named by a lease no longer
// exists, or its endpoint or event does not. The lease is released and nothing
// is written: there is no row left to record an attempt against.
var ErrDeliveryGone = errors.New("worker: delivery no longer exists")

// EncryptedSecret is one endpoint_secrets row as it sits on disk. The plaintext
// never leaves the worker process and is never returned by this layer, so a
// query result accidentally logged cannot leak a signing secret.
type EncryptedSecret struct {
	ID      string
	Version int
	// Envelope is the `v1.<kid>.<iv>.<tag>.<ct>` string from
	// endpoint_secrets.secret_encrypted.
	Envelope string
}

// Endpoint is the delivery target's configuration.
type Endpoint struct {
	ID              string
	URL             string
	Status          string
	Enabled         bool
	Timeout         time.Duration
	MaxConcurrency  int
	RateLimit       int // 0 means no endpoint rate limit
	RateLimitWindow time.Duration
	CustomHeaders   map[string]string
}

// Deliverable reports whether the endpoint should still receive traffic. A
// paused, disabled or deleted endpoint cancels the delivery rather than
// retrying it: the retry budget exists for endpoints that might come back, and
// an operator toggling `enabled` is not a transient network fault.
func (e Endpoint) Deliverable() (bool, Reason) {
	switch e.Status {
	case "deleted":
		return false, ReasonEndpointDeleted
	case "paused", "disabled":
		return false, ReasonEndpointDisabled
	}
	if !e.Enabled {
		return false, ReasonEndpointDisabled
	}
	return true, ""
}

// Job is everything one delivery attempt needs, read in two queries.
type Job struct {
	DeliveryID     string
	EventID        string
	OrganizationID string
	ProjectID      string
	EventType      string
	OrderingKey    string

	// AttemptNumber is 1-based and is the number this attempt will carry. It
	// is derived from attempt_count, which is why attempt_count and the
	// delivery_attempts row must be written in the same transaction.
	AttemptNumber int

	// Payload is events.payload_raw: the EXACT bytes the customer sent. This
	// is what is signed and what is delivered. Never the jsonb projection.
	Payload         []byte
	PayloadLocation string

	EventCreatedAt time.Time
	FirstAttemptAt time.Time

	Endpoint Endpoint
	Policy   retry.Policy
	Secrets  []EncryptedSecret
}

// AttemptRecord is one append-only delivery_attempts row (ARCHITECTURE.md 33).
// Nothing ever updates a row once written; a second attempt is a second row.
type AttemptRecord struct {
	Number          int
	StartedAt       time.Time
	CompletedAt     time.Time
	Status          AttemptStatus
	HTTPStatus      int
	RequestHeaders  map[string]string
	ResponseHeaders map[string]string
	ResponseBody    string
	ResponseSize    int
	ErrorCode       string
	ErrorMessage    string
	Duration        time.Duration
	WorkerID        string
}

// Transition is one move of the delivery state machine, with its reason.
type Transition struct {
	State  State
	Reason Reason
	// Delay is measured from the DATABASE's clock, not this process's:
	// next_attempt_at is compared against now() by the claim predicate, so
	// computing it server-side removes app/DB clock skew from the one
	// comparison that decides whether a delivery is ever picked up again.
	Delay time.Duration
	// AttemptCount is the new deliveries.attempt_count. Zero leaves it alone,
	// which is what a deferral wants.
	AttemptCount int
}

// Store is the worker's whole database surface.
type Store interface {
	// Load reads the delivery, its endpoint, its event payload and its active
	// secrets.
	Load(ctx context.Context, deliveryID string) (*Job, error)

	// Complete appends the attempt row and advances the delivery IN ONE
	// TRANSACTION, guarded by the lease. It returns queue.ErrLeaseLost - via
	// ErrLeaseNotHeld - when the delivery is no longer locked by workerID, in
	// which case NOTHING is written.
	Complete(ctx context.Context, workerID, deliveryID string, attempt *AttemptRecord, next Transition) error

	// Defer reschedules without recording an attempt: the breaker, a rate
	// limit or a concurrency ceiling said no, so no attempt was made and none
	// may be charged against the retry budget.
	Defer(ctx context.Context, workerID, deliveryID string, next Transition) error
}

// HealthStore is the circuit breaker's database surface, split from Store so a
// test can fake one without the other.
type HealthStore interface {
	Health(ctx context.Context, endpointID string) (Health, error)
	ClaimProbe(ctx context.Context, endpointID string, ttl time.Duration) (bool, error)
	RecordOutcome(ctx context.Context, endpointID string, success bool, cfg BreakerConfig, jitter float64) (prev, next Health, err error)
}

// ErrLeaseNotHeld is returned by Complete and Defer when the guarded UPDATE
// matched no row. It is wrapped so callers can compare against
// queue.ErrLeaseLost without importing this package's internals.
var ErrLeaseNotHeld = errors.New("worker: delivery is no longer leased by this worker")

// PostgresStore is the production Store and HealthStore.
type PostgresStore struct {
	pool *pgxpool.Pool
}

// NewPostgresStore builds the store.
func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore { return &PostgresStore{pool: pool} }

var _ Store = (*PostgresStore)(nil)
var _ HealthStore = (*PostgresStore)(nil)

// loadJobSQL reads everything but the secrets in one round trip.
//
// FirstAttemptAt is the earliest recorded attempt, falling back to the row's
// creation: it is the origin of the max_retry_duration budget, and taking it
// from the ledger rather than from a column means a replayed or reclaimed
// delivery cannot quietly reset its own clock.
const loadJobSQL = `
SELECT d.event_id, d.organization_id, d.project_id,
       d.attempt_count, d.max_attempts,
       e.id, e.url, e.status::text, e.enabled, e.timeout_ms, e.max_concurrency,
       COALESCE(e.rate_limit, 0), e.rate_limit_window_seconds,
       COALESCE(e.custom_headers::text, ''),
       ev.event_type, ev.payload_raw, COALESCE(ev.payload_location, ''),
       COALESCE(ev.ordering_key, ''), ev.created_at,
       COALESCE(
         (SELECT MIN(a.started_at) FROM delivery_attempts a WHERE a.delivery_id = d.id),
         d.created_at),
       rp.strategy, rp.max_attempts, rp.initial_delay_ms, rp.max_delay_ms,
       rp.multiplier, rp.jitter_ratio, rp.max_retry_duration_ms
FROM deliveries d
JOIN endpoints e ON e.id = d.endpoint_id
JOIN events ev   ON ev.id = d.event_id
-- Resolve the retry policy the SAME way the router resolves max_attempts:
-- the endpoint's own policy if it has one, otherwise the project default,
-- otherwise the built-in (rp is NULL and the caller falls back).
--
-- Joining only on e.retry_policy_id skipped the project default entirely, so an
-- operator who set a default policy got its max_attempts honoured by the router
-- and its backoff ignored here - half a policy, silently. Observed in a live
-- run as 5s/10s/20s gaps under a policy that specified 1s capped at 5s.
LEFT JOIN LATERAL (
    SELECT p.*
    FROM retry_policies p
    WHERE p.id = e.retry_policy_id
       OR (e.retry_policy_id IS NULL AND p.project_id = d.project_id AND p.is_default)
    ORDER BY (p.id = e.retry_policy_id) DESC
    LIMIT 1
) rp ON true
WHERE d.id = $1
`

// loadSecretsSQL returns the secrets that may sign RIGHT NOW, newest first.
//
// The `expires_at > now()` half is not redundant with `active`: the control
// plane flips `active` off lazily, as housekeeping after a rotation, and its
// own isEffectivelyActive() applies exactly this pair. A worker that trusted
// `active` alone would sign with a secret the customer has already been told
// is dead.
const loadSecretsSQL = `
SELECT id, version, secret_encrypted
FROM endpoint_secrets
WHERE endpoint_id = $1
  AND active
  AND (expires_at IS NULL OR expires_at > now())
ORDER BY version DESC
`

// Load implements Store.
func (s *PostgresStore) Load(ctx context.Context, deliveryID string) (*Job, error) {
	job := &Job{DeliveryID: deliveryID}

	var (
		attemptCount       int
		deliveryMaxAttempt int
		timeoutMS          int
		rateWindowSeconds  int
		customHeadersJSON  string

		strategy         *string
		policyMaxAttempt *int
		initialDelayMS   *int
		maxDelayMS       *int
		multiplier       *float64
		jitterRatio      *float64
		maxDurationMS    *int
	)

	err := s.pool.QueryRow(ctx, loadJobSQL, deliveryID).Scan(
		&job.EventID, &job.OrganizationID, &job.ProjectID,
		&attemptCount, &deliveryMaxAttempt,
		&job.Endpoint.ID, &job.Endpoint.URL, &job.Endpoint.Status, &job.Endpoint.Enabled,
		&timeoutMS, &job.Endpoint.MaxConcurrency,
		&job.Endpoint.RateLimit, &rateWindowSeconds,
		&customHeadersJSON,
		&job.EventType, &job.Payload, &job.PayloadLocation,
		&job.OrderingKey, &job.EventCreatedAt,
		&job.FirstAttemptAt,
		&strategy, &policyMaxAttempt, &initialDelayMS, &maxDelayMS,
		&multiplier, &jitterRatio, &maxDurationMS,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrDeliveryGone
	}
	if err != nil {
		return nil, fmt.Errorf("load delivery %s: %w", deliveryID, err)
	}

	job.AttemptNumber = attemptCount + 1
	job.Endpoint.Timeout = time.Duration(timeoutMS) * time.Millisecond
	job.Endpoint.RateLimitWindow = time.Duration(rateWindowSeconds) * time.Second
	if job.Endpoint.RateLimitWindow <= 0 {
		job.Endpoint.RateLimitWindow = time.Second
	}
	job.Endpoint.CustomHeaders = parseCustomHeaders(customHeadersJSON)

	job.Policy = retry.DefaultPolicy()
	if strategy != nil {
		job.Policy.Strategy = *strategy
	}
	if policyMaxAttempt != nil && *policyMaxAttempt > 0 {
		job.Policy.MaxAttempts = *policyMaxAttempt
	}
	if initialDelayMS != nil {
		job.Policy.InitialDelay = time.Duration(*initialDelayMS) * time.Millisecond
	}
	if maxDelayMS != nil {
		job.Policy.MaxDelay = time.Duration(*maxDelayMS) * time.Millisecond
	}
	if multiplier != nil {
		job.Policy.Multiplier = *multiplier
	}
	if jitterRatio != nil {
		job.Policy.JitterRatio = *jitterRatio
	}
	if maxDurationMS != nil {
		job.Policy.MaxRetryDuration = time.Duration(*maxDurationMS) * time.Millisecond
	}
	// deliveries.max_attempts is the budget FROZEN onto this delivery when the
	// router created it. It wins over the endpoint's current policy so that
	// editing a retry policy mid-flight cannot extend or truncate deliveries
	// that are already in progress - the ledger says what this delivery was
	// promised, and that is what it gets.
	if deliveryMaxAttempt > 0 {
		job.Policy.MaxAttempts = deliveryMaxAttempt
	}

	rows, err := s.pool.Query(ctx, loadSecretsSQL, job.Endpoint.ID)
	if err != nil {
		return nil, fmt.Errorf("load endpoint secrets: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var sec EncryptedSecret
		if err := rows.Scan(&sec.ID, &sec.Version, &sec.Envelope); err != nil {
			return nil, fmt.Errorf("scan endpoint secret: %w", err)
		}
		job.Secrets = append(job.Secrets, sec)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate endpoint secrets: %w", err)
	}
	return job, nil
}

// advanceSQL is the guarded state transition.
//
// `locked_by = $2` is the crash-safety guard and the reason both writes sit in
// one transaction. If this worker's lease lapsed while its HTTP request was in
// flight and another worker reclaimed the delivery, this UPDATE matches zero
// rows, the transaction rolls back, and the attempt row goes with it. Without
// the guard two workers would both append an attempt and race over the terminal
// status, and whichever committed last would decide whether the customer's
// delivery "succeeded".
//
// next_attempt_at is computed from the SERVER's now(), so the ready predicate
// in internal/queue compares two values produced by the same clock.
const advanceSQL = `
UPDATE deliveries
SET status          = $3::text::"DeliveryStatus",
    attempt_count   = CASE WHEN $4::int > 0 THEN $4::int ELSE attempt_count END,
    last_attempt_at = CASE WHEN $4::int > 0 THEN now() ELSE last_attempt_at END,
    next_attempt_at = CASE WHEN $5::bool THEN now() + $6::interval ELSE NULL END,
    completed_at    = CASE WHEN $7::bool THEN now() ELSE completed_at END,
    last_error      = $8,
    locked_by       = NULL,
    locked_until    = NULL,
    updated_at      = now()
WHERE id = $1
  AND locked_by = $2
RETURNING id
`

const insertAttemptSQL = `
INSERT INTO delivery_attempts (
    id, delivery_id, attempt_number, started_at, completed_at, status,
    http_status, request_headers, response_headers, response_body,
    response_size, error_code, error_message, duration_ms, worker_id, created_at)
VALUES ($1, $2, $3, $4, $5, $6::text::"AttemptStatus", $7, $8::jsonb, $9::jsonb,
        $10, $11, $12, $13, $14, $15, now())
`

// Complete implements Store.
func (s *PostgresStore) Complete(
	ctx context.Context, workerID, deliveryID string, attempt *AttemptRecord, next Transition,
) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin delivery transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := advanceExec(ctx, tx, workerID, deliveryID, next); err != nil {
		return err
	}

	if attempt != nil {
		if err := insertAttempt(ctx, tx, deliveryID, attempt); err != nil {
			return err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit delivery %s: %w", deliveryID, err)
	}
	return nil
}

// Defer implements Store.
func (s *PostgresStore) Defer(ctx context.Context, workerID, deliveryID string, next Transition) error {
	return advanceExec(ctx, s.pool, workerID, deliveryID, next)
}

// execer is the subset of pgx both a pool and a transaction satisfy.
type execer interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func advanceExec(ctx context.Context, q execer, workerID, deliveryID string, next Transition) error {
	schedule := !next.State.Terminal()
	delay := next.Delay
	if delay < 0 {
		delay = 0
	}
	// last_error carries the reason for everything EXCEPT a success. Writing
	// "delivered" into a column called last_error is the kind of small lie that
	// makes an operator distrust the whole ledger; a succeeded delivery clears
	// it instead, and why it once retried is in delivery_attempts.
	var reason any
	if next.State != StateSucceeded && next.Reason != "" {
		reason = string(next.Reason)
	}

	var id string
	err := q.QueryRow(ctx, advanceSQL,
		deliveryID,
		workerID,
		string(next.State),
		next.AttemptCount,
		schedule,
		intervalOf(delay),
		next.State.Terminal(),
		reason,
	).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("advance delivery %s to %s: %w", deliveryID, next.State, ErrLeaseNotHeld)
	}
	if err != nil {
		return fmt.Errorf("advance delivery %s to %s: %w", deliveryID, next.State, err)
	}
	return nil
}

func insertAttempt(ctx context.Context, tx pgx.Tx, deliveryID string, a *AttemptRecord) error {
	var httpStatus any
	if a.HTTPStatus > 0 {
		httpStatus = a.HTTPStatus
	}
	_, err := tx.Exec(ctx, insertAttemptSQL,
		ids.New(ids.Attempt),
		deliveryID,
		a.Number,
		a.StartedAt.UTC(),
		a.CompletedAt.UTC(),
		string(a.Status),
		httpStatus,
		jsonOrNil(a.RequestHeaders),
		jsonOrNil(a.ResponseHeaders),
		textOrNil(a.ResponseBody),
		a.ResponseSize,
		textOrNil(a.ErrorCode),
		textOrNil(a.ErrorMessage),
		int(a.Duration.Milliseconds()),
		textOrNil(a.WorkerID),
	)
	if err != nil {
		return fmt.Errorf("record attempt %d for delivery %s: %w", a.Number, deliveryID, err)
	}
	return nil
}

// --- circuit breaker ------------------------------------------------------

const healthSQL = `
SELECT state::text, consecutive_failures, consecutive_successes, opened_at, probe_after
FROM endpoint_health
WHERE endpoint_id = $1
`

// Health implements HealthStore. A missing row means the endpoint has never
// failed, which is healthy.
func (s *PostgresStore) Health(ctx context.Context, endpointID string) (Health, error) {
	var (
		h          Health
		state      string
		openedAt   *time.Time
		probeAfter *time.Time
	)
	err := s.pool.QueryRow(ctx, healthSQL, endpointID).Scan(
		&state, &h.ConsecutiveFailures, &h.ConsecutiveSuccesses, &openedAt, &probeAfter)
	if errors.Is(err, pgx.ErrNoRows) {
		return Health{State: HealthHealthy}, nil
	}
	if err != nil {
		return Health{}, fmt.Errorf("read endpoint health: %w", err)
	}
	h.State = HealthState(state)
	if openedAt != nil {
		h.OpenedAt = *openedAt
	}
	if probeAfter != nil {
		h.ProbeAfter = *probeAfter
	}
	return h, nil
}

// claimProbeSQL is the mutual exclusion that prevents a thundering herd on
// recovery (ARCHITECTURE.md 26).
//
// Exactly one worker's UPDATE matches, because the predicate that admits a
// probe is also the write that withdraws the invitation. Every other worker
// gets zero rows and defers. `state IN ('open','half_open')` covers the worker
// that died mid-probe: its half_open slot expires with probe_after and the next
// worker takes it, rather than leaving the endpoint permanently half_open and
// permanently undeliverable.
const claimProbeSQL = `
UPDATE endpoint_health
SET state                 = 'half_open',
    -- Reset the success run ONLY on the open -> half_open transition. Resetting
    -- it on every probe claim makes HalfOpenSuccesses unreachable: the probe
    -- zeroes the counter, the delivery succeeds and sets it to 1, the next probe
    -- zeroes it again. A fully recovered endpoint then sits in half_open
    -- forever, admitting one delivery per probe cycle and never closing.
    -- Observed live: six consecutive successful deliveries, counter never past 1.
    consecutive_successes = CASE WHEN state = 'open' THEN 0 ELSE consecutive_successes END,
    probe_after           = now() + $2::interval,
    updated_at            = now()
WHERE endpoint_id = $1
  AND state IN ('open', 'half_open')
  AND probe_after IS NOT NULL
  AND probe_after <= now()
RETURNING endpoint_id
`

// ClaimProbe implements HealthStore.
func (s *PostgresStore) ClaimProbe(ctx context.Context, endpointID string, ttl time.Duration) (bool, error) {
	var id string
	err := s.pool.QueryRow(ctx, claimProbeSQL, endpointID, intervalOf(ttl)).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("claim breaker probe: %w", err)
	}
	return true, nil
}

// recordSuccessSQL mirrors NextHealth's success branch. The CASE arithmetic is
// done by PostgreSQL, not by this process, so two workers finishing at the same
// instant cannot both read the same counter and both write the same increment.
//
// The `prev` CTE reads the pre-update row inside the same snapshot, which is
// how the caller learns that a transition happened without a second round trip.
const recordSuccessSQL = `
WITH prev AS (
    SELECT state, consecutive_failures, consecutive_successes, opened_at, probe_after
    FROM endpoint_health WHERE endpoint_id = $1
)
INSERT INTO endpoint_health (
    endpoint_id, state, consecutive_failures, consecutive_successes,
    last_success_at, opened_at, probe_after, updated_at)
VALUES ($1, 'healthy', 0, 1, now(), NULL, NULL, now())
ON CONFLICT (endpoint_id) DO UPDATE SET
    consecutive_failures  = 0,
    consecutive_successes = endpoint_health.consecutive_successes + 1,
    last_success_at       = now(),
    state = CASE
        WHEN endpoint_health.state = 'half_open'
         AND endpoint_health.consecutive_successes + 1 < $2::int
        THEN 'half_open'::"EndpointHealthState"
        ELSE 'healthy'::"EndpointHealthState"
    END,
    opened_at = CASE
        WHEN endpoint_health.state = 'half_open'
         AND endpoint_health.consecutive_successes + 1 < $2::int
        THEN endpoint_health.opened_at
        ELSE NULL
    END,
    probe_after = CASE
        WHEN endpoint_health.state = 'half_open'
         AND endpoint_health.consecutive_successes + 1 < $2::int
        THEN now()
        ELSE NULL
    END,
    updated_at = now()
RETURNING
    state::text, consecutive_failures, consecutive_successes, opened_at, probe_after,
    (SELECT state::text FROM prev), (SELECT consecutive_failures FROM prev),
    (SELECT consecutive_successes FROM prev), (SELECT opened_at FROM prev),
    (SELECT probe_after FROM prev)
`

// recordFailureSQL mirrors NextHealth's failure branch, including the doubling
// cooldown with jitter. Computing the cooldown in SQL is not cleverness for its
// own sake: the new failure count only exists after the increment, and doing
// the arithmetic here keeps the read, the increment and the cooldown in one
// atomic statement.
const recordFailureSQL = `
WITH prev AS (
    SELECT state, consecutive_failures, consecutive_successes, opened_at, probe_after
    FROM endpoint_health WHERE endpoint_id = $1
)
INSERT INTO endpoint_health (
    endpoint_id, state, consecutive_failures, consecutive_successes,
    last_failure_at, opened_at, probe_after, updated_at)
VALUES ($1, $2::text::"EndpointHealthState", 1, 0, now(), $3, $4, now())
ON CONFLICT (endpoint_id) DO UPDATE SET
    consecutive_failures  = endpoint_health.consecutive_failures + 1,
    consecutive_successes = 0,
    last_failure_at       = now(),
    state = CASE
        WHEN endpoint_health.state = 'half_open'
          OR endpoint_health.consecutive_failures + 1 >= $5::int
        THEN 'open'::"EndpointHealthState"
        WHEN endpoint_health.consecutive_failures + 1 >= $6::int
        THEN 'degraded'::"EndpointHealthState"
        ELSE endpoint_health.state
    END,
    opened_at = CASE
        WHEN endpoint_health.state = 'half_open'
          OR endpoint_health.consecutive_failures + 1 >= $5::int
        THEN COALESCE(endpoint_health.opened_at, now())
        ELSE endpoint_health.opened_at
    END,
    probe_after = CASE
        WHEN endpoint_health.state = 'half_open'
          OR endpoint_health.consecutive_failures + 1 >= $5::int
        THEN now() + make_interval(secs => GREATEST(1, LEAST(
                 $7::double precision,
                 $8::double precision * power(2::double precision,
                     LEAST(20, GREATEST(0, endpoint_health.consecutive_failures + 1 - $5::int)))
             ) * $9::double precision))
        ELSE endpoint_health.probe_after
    END,
    updated_at = now()
RETURNING
    state::text, consecutive_failures, consecutive_successes, opened_at, probe_after,
    (SELECT state::text FROM prev), (SELECT consecutive_failures FROM prev),
    (SELECT consecutive_successes FROM prev), (SELECT opened_at FROM prev),
    (SELECT probe_after FROM prev)
`

// RecordOutcome implements HealthStore.
func (s *PostgresStore) RecordOutcome(
	ctx context.Context, endpointID string, success bool, cfg BreakerConfig, jitter float64,
) (Health, Health, error) {
	cfg = cfg.withDefaults()
	if jitter <= 0 {
		jitter = 1
	}

	var row pgx.Row
	if success {
		row = s.pool.QueryRow(ctx, recordSuccessSQL, endpointID, cfg.HalfOpenSuccesses)
	} else {
		// The insert branch is the endpoint's very first failure, so the count
		// is 1 and the resulting state is knowable here.
		first := NextHealth(Health{State: HealthHealthy}, false, cfg, time.Now(), jitter)
		var openedAt, probeAfter any
		if !first.OpenedAt.IsZero() {
			openedAt = first.OpenedAt.UTC()
		}
		if !first.ProbeAfter.IsZero() {
			probeAfter = first.ProbeAfter.UTC()
		}
		row = s.pool.QueryRow(ctx, recordFailureSQL,
			endpointID, string(first.State), openedAt, probeAfter,
			cfg.OpenThreshold, cfg.DegradedThreshold,
			cfg.MaxCooldown.Seconds(), cfg.BaseCooldown.Seconds(), jitter)
	}

	var (
		next, prev             Health
		nextState              string
		prevState              *string
		nextOpened, nextProbe  *time.Time
		prevOpened, prevProbe  *time.Time
		prevFailures, prevWins *int
	)
	err := row.Scan(
		&nextState, &next.ConsecutiveFailures, &next.ConsecutiveSuccesses, &nextOpened, &nextProbe,
		&prevState, &prevFailures, &prevWins, &prevOpened, &prevProbe,
	)
	if err != nil {
		return Health{}, Health{}, fmt.Errorf("record endpoint health: %w", err)
	}

	next.State = HealthState(nextState)
	if nextOpened != nil {
		next.OpenedAt = *nextOpened
	}
	if nextProbe != nil {
		next.ProbeAfter = *nextProbe
	}
	if prevState != nil {
		prev.State = HealthState(*prevState)
	}
	if prevFailures != nil {
		prev.ConsecutiveFailures = *prevFailures
	}
	if prevWins != nil {
		prev.ConsecutiveSuccesses = *prevWins
	}
	if prevOpened != nil {
		prev.OpenedAt = *prevOpened
	}
	if prevProbe != nil {
		prev.ProbeAfter = *prevProbe
	}
	return prev, next, nil
}

// --- helpers --------------------------------------------------------------

// intervalOf formats a duration for a PostgreSQL interval parameter, matching
// internal/queue so the two agree on precision.
func intervalOf(d time.Duration) string {
	return fmt.Sprintf("%d milliseconds", d.Milliseconds())
}

// parseCustomHeaders reads endpoints.custom_headers. Only string values are
// accepted: a number or an object in there is a control-plane bug, and
// stringifying it would send a header the customer never wrote.
func parseCustomHeaders(raw string) map[string]string {
	if raw == "" || raw == "null" {
		return nil
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil
	}
	out := make(map[string]string, len(decoded))
	for k, v := range decoded {
		if s, ok := v.(string); ok {
			out[k] = s
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func jsonOrNil(m map[string]string) any {
	if len(m) == 0 {
		return nil
	}
	b, err := json.Marshal(m)
	if err != nil {
		return nil
	}
	return string(b)
}

func textOrNil(s string) any {
	if s == "" {
		return nil
	}
	return s
}
