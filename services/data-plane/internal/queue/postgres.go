package queue

import (
	"context"
	"fmt"
	"math"
	"math/rand"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/shaq/webhook-platform/services/data-plane/internal/metrics"
)

// claimStatuses is the ready set.
//
// `processing` is in this list on purpose, and removing it reintroduces a data
// loss bug. A leased row is `processing`; if the claim predicate excludes that
// status then an expired lease is never reclaimable by a worker, and the only
// path back is the scheduler's ReclaimExpired. Deploy 8 workers and 1 scheduler
// (ADR-0005), lose the scheduler, then OOM-kill a worker holding 100 leases,
// and those 100 deliveries sit in `processing` forever: never retried, never
// exhausted, never surfaced as failed. That breaks the invariant the whole
// design rests on - an event that returned 202 is recoverable from PostgreSQL
// alone (ADR-0003).
//
// Including it is safe because the `locked_until IS NULL OR locked_until <
// now()` predicate below is what actually decides claimability, and it is
// evaluated inside FOR UPDATE SKIP LOCKED. A live lease is never stolen: its
// locked_until is in the future.
const claimStatuses = `('pending', 'scheduled', 'queued', 'retrying', 'processing')`

// readyPredicate is the shared definition of "this row wants a worker".
//
// next_attempt_at is NOT NULL (20260911000000_next_attempt_at_not_null), so
// this is a plain range predicate. It used to carry `next_attempt_at IS NULL
// OR`, a workaround for a nullable column whose NULL meant "due immediately"
// and - under the NULLS FIRST ordering the claim then used - sorted ahead of
// every retry that was actually due. The constraint rejects that write at the
// source now, so nothing here has to tolerate it.
const readyPredicate = `
      status IN ` + claimStatuses + `
      AND next_attempt_at <= now()
      AND (locked_until IS NULL OR locked_until < now())`

// claimedColumns is the RETURNING list shared by both claim strategies.
//
// The last column is the fairness SLI of ADR-0007: how long the row was ready
// before anybody claimed it, measured by the database so it carries no clock
// skew between application and server. Scheduling delay only - the attempt has
// not happened yet.
const claimedColumns = `
          d.id, d.event_id, d.endpoint_id, d.organization_id, d.project_id,
          d.attempt_count, d.next_attempt_at,
          COALESCE(d.ordering_key, ''), d.locked_until,
          GREATEST(EXTRACT(EPOCH FROM (now() - d.next_attempt_at)), 0)::double precision,
          COALESCE(d.trace_context, '')`

// claimFIFOSQL leases the globally oldest ready deliveries.
//
//   - SKIP LOCKED lets N workers poll concurrently without blocking each other.
//   - The WHERE clause treats an expired lease as reclaimable, which is how a
//     crashed worker's in-flight deliveries come back - see claimStatuses.
//   - The row is moved to `processing` in the same statement, so a claim is
//     visible to the operator UI immediately.
//
// claimFIFOSQL picks the batch in a MATERIALIZED CTE and only then updates.
//
// It used to be `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED
// LIMIT $3)`, which is the textbook shape and is WRONG under one planner
// choice. When the statistics say the table is tiny - relpages high,
// reltuples near zero, which is exactly what autovacuum leaves behind after a
// burst is drained or a retention sweep empties the table - the planner runs
// the IN-subquery on the INNER side of a nested-loop semi join, re-executing
// Sort -> LockRows -> Limit once per outer row. On each re-execution LockRows
// re-locks the first sorted row; a row this same UPDATE already modified is
// TM_SelfModified, which LockRows treats as deleted and skips, so the NEXT tied
// row becomes that turn's LIMIT-1 winner and matches the next outer row. With
// a fan-out batch every row ties on (next_attempt_at, created_at), so a claim
// of LIMIT 1 returned every ready row: measured 5 of 5, ten times out of ten,
// against relpages=14 reltuples=1, and reproduced inside the failure suite at
// relpages=6 reltuples=0. Under any other statistics state the planner hashes
// the subquery once and the LIMIT holds - which is why it read as flakiness.
//
// A MATERIALIZED CTE is evaluated exactly once into a tuplestore before the
// UPDATE joins to it, so the batch is bounded by construction, whatever plan
// the join takes. The id tiebreaker makes the order deterministic among rows
// that tie, which a fan-out batch always does.
//
// The ORDER BY is, column for column, the key of deliveries_ready_fifo_idx
// (next_attempt_at, created_at, id; no NULLS FIRST since 20260911000000), so
// the index delivers the claim's order and the plan carries no sort node.
// TestClaimStatementsCanUseTheReadySetIndexes pins that; change one side
// without the other and the planner silently sorts the whole ready set on
// every poll.
const claimFIFOSQL = `
WITH picked AS MATERIALIZED (
    SELECT id AS picked_id
    FROM deliveries
    WHERE ` + readyPredicate + `
    ORDER BY next_attempt_at, created_at, id
    FOR UPDATE SKIP LOCKED
    LIMIT $3
)
UPDATE deliveries d
SET status        = 'processing',
    locked_by     = $1,
    locked_until  = now() + $2::interval,
    updated_at    = now()
FROM picked
WHERE d.id = picked.picked_id
RETURNING ` + claimedColumns

// claimTenantFairSQL is the ADR-0007 claim: one bounded pick per tenant in the
// batch, so a 100k-event burst in one project cannot fill every slot.
//
// $3/$4 are the shuffled tenant pairs as parallel arrays, $5 is the derived
// per-tenant cap, $6 the overall claim limit. FOR UPDATE SKIP LOCKED sits
// inside the LATERAL, which is an inner join, so per-row locking and skipping
// behave exactly as in the FIFO statement.
// Same MATERIALIZED shape as claimFIFOSQL, for the same reason: a FROM-subquery
// with LIMIT can land on the inner side of a nested loop and be re-run per outer
// row, and LockRows skipping self-modified rows would then over-claim across
// the whole batch. See the comment on claimFIFOSQL.
const claimTenantFairSQL = `
WITH picked AS MATERIALIZED (
    SELECT c.id AS picked_id
    FROM unnest($3::text[], $4::text[]) AS t(organization_id, project_id)
    CROSS JOIN LATERAL (
        SELECT dd.id
        FROM deliveries dd
        WHERE dd.organization_id = t.organization_id
          AND dd.project_id      = t.project_id
          AND dd.status IN ` + claimStatuses + `
          AND dd.next_attempt_at <= now()
          AND (dd.locked_until IS NULL OR dd.locked_until < now())
        ORDER BY dd.next_attempt_at, dd.created_at, dd.id
        LIMIT $5
        FOR UPDATE SKIP LOCKED
    ) c
    LIMIT $6
)
UPDATE deliveries d
SET status        = 'processing',
    locked_by     = $1,
    locked_until  = now() + $2::interval,
    updated_at    = now()
FROM picked
WHERE d.id = picked.picked_id
RETURNING ` + claimedColumns

// tenantSnapshotSQL is PostgreSQL's missing loose index scan, written by hand.
// It costs one index descent per distinct tenant with ready work rather than a
// scan of the whole ready set, which is what makes refreshing it on a ticker
// affordable. $1/$2 are the rotating cursor, $3 the snapshot size.
const tenantSnapshotSQL = `
WITH RECURSIVE ready_tenants AS (
    (SELECT d.organization_id, d.project_id
       FROM deliveries d
      WHERE ` + readyPredicate + `
        AND (d.organization_id, d.project_id) > ($1::text, $2::text)
      ORDER BY d.organization_id, d.project_id
      LIMIT 1)
    UNION ALL
    SELECT n.organization_id, n.project_id
      FROM ready_tenants t
      CROSS JOIN LATERAL (
          SELECT d.organization_id, d.project_id
            FROM deliveries d
           WHERE ` + readyPredicate + `
             AND (d.organization_id, d.project_id) > (t.organization_id, t.project_id)
           ORDER BY d.organization_id, d.project_id
           LIMIT 1
      ) n
)
SELECT organization_id, project_id
  FROM ready_tenants
 LIMIT $3`

// Strategy selects how Claim picks its batch.
type Strategy string

const (
	// StrategyFIFO is the default: the globally oldest ready deliveries win.
	StrategyFIFO Strategy = "fifo"

	// StrategyTenantFair is ADR-0007: a per-project cap inside the claim query,
	// derived from the number of active tenants in the batch.
	StrategyTenantFair Strategy = "tenant_fair"
)

// ParseStrategy validates a configured strategy name.
func ParseStrategy(raw string) (Strategy, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", string(StrategyFIFO):
		return StrategyFIFO, nil
	case string(StrategyTenantFair), "lateral", "tenant-fair":
		return StrategyTenantFair, nil
	default:
		return "", fmt.Errorf("unknown claim strategy %q: expected %s or %s", raw, StrategyFIFO, StrategyTenantFair)
	}
}

// PostgresQueue claims work directly from the deliveries table.
//
// Why the durable table is also the queue, for now: the delivery row must be
// written before any attempt is made regardless (that is what makes replay
// possible), so a separate queue would be a second copy of state we already
// have - and a second thing to reconcile after a crash. FOR UPDATE SKIP LOCKED
// gives multi-worker safety without that duplication, and comfortably carries
// the throughput an MVP needs.
type PostgresQueue struct {
	pool     *pgxpool.Pool
	strategy Strategy

	// snapshotTTL bounds how stale the tenant list may be. ADR-0007 refreshes
	// on a 1s ticker; refreshing lazily on the first Claim after the TTL
	// expires is the same rate without a second goroutine to shut down.
	snapshotTTL time.Duration

	mu            sync.Mutex
	rng           *rand.Rand
	snapshot      []tenant
	snapshotAt    time.Time
	cursorOrg     string
	cursorProject string
}

type tenant struct {
	OrganizationID string
	ProjectID      string
}

// NewPostgresQueue builds a queue using the given claim strategy.
//
// The default is StrategyFIFO, deliberately inverting the default stated in
// ADR-0007. Nothing has been measured yet, and ARCHITECTURE.md's own rule is to
// prefer the simplest production-grade option. (The prerequisite index and the
// NOT NULL migration ADR-0007 asked for are both applied now, so neither is a
// reason to hold the default any more; the missing measurement is.) StrategyTenantFair is fully implemented
// and opt-in via CLAIM_STRATEGY; it becomes the default when
// queue_head_of_line_delay_seconds actually shows starvation. See HANDOFF.md.
func NewPostgresQueue(pool *pgxpool.Pool, strategy Strategy) *PostgresQueue {
	if strategy == "" {
		strategy = StrategyFIFO
	}
	return &PostgresQueue{
		pool:        pool,
		strategy:    strategy,
		snapshotTTL: time.Second,
		rng:         rand.New(rand.NewSource(time.Now().UnixNano())),
	}
}

// Strategy reports the configured claim strategy, for startup logging.
func (q *PostgresQueue) Strategy() Strategy { return q.strategy }

func (q *PostgresQueue) Claim(ctx context.Context, workerID string, limit int, lease time.Duration) ([]Lease, error) {
	if limit <= 0 {
		return nil, fmt.Errorf("claim limit must be positive")
	}

	started := time.Now()
	strategy := q.strategy
	tenants := 0

	var (
		leases []Lease
		err    error
	)
	if q.strategy == StrategyTenantFair {
		var batch []tenant
		batch, err = q.tenantBatch(ctx, limit)
		if err != nil || len(batch) == 0 {
			// ADR-0007's fallback: an empty or failed snapshot must not mean
			// claiming nothing. FIFO for this poll is strictly better than idle
			// workers in front of a backlog.
			strategy = StrategyFIFO
		} else {
			tenants = len(batch)
			leases, err = q.claimTenantFair(ctx, workerID, limit, lease, batch)
		}
	}
	if strategy == StrategyFIFO {
		leases, err = q.claimFIFO(ctx, workerID, limit, lease)
	}

	metrics.QueueClaimDuration.WithLabelValues(string(strategy)).Observe(time.Since(started).Seconds())
	if err != nil {
		return nil, err
	}
	metrics.QueueClaimBatchSize.WithLabelValues(string(strategy)).Observe(float64(len(leases)))
	metrics.QueueClaimTenants.Observe(float64(tenants))
	for _, l := range leases {
		metrics.QueueHeadOfLineDelay.Observe(l.HeadOfLineDelay.Seconds())
	}
	return leases, nil
}

func (q *PostgresQueue) claimFIFO(ctx context.Context, workerID string, limit int, lease time.Duration) ([]Lease, error) {
	rows, err := q.pool.Query(ctx, claimFIFOSQL, workerID, intervalOf(lease), limit)
	if err != nil {
		return nil, fmt.Errorf("claim deliveries: %w", err)
	}
	return scanLeases(rows, workerID)
}

func (q *PostgresQueue) claimTenantFair(
	ctx context.Context, workerID string, limit int, lease time.Duration, batch []tenant,
) ([]Lease, error) {
	orgs := make([]string, len(batch))
	projects := make([]string, len(batch))
	for i, t := range batch {
		orgs[i] = t.OrganizationID
		projects[i] = t.ProjectID
	}
	rows, err := q.pool.Query(ctx, claimTenantFairSQL,
		workerID, intervalOf(lease), orgs, projects, perTenantCap(limit, len(batch)), limit)
	if err != nil {
		return nil, fmt.Errorf("claim deliveries (tenant fair): %w", err)
	}
	return scanLeases(rows, workerID)
}

// perTenantCap derives each tenant's slice of one claim batch.
//
// The cap is derived from the number of active tenants, never a constant. With
// a single active tenant K is 1, the cap is the whole batch, and the query
// degenerates to FIFO with one extra index descent - which is the point. A
// fixed cap would throttle a lone tenant to `cap` rows per poll and leave the
// pool idle in front of its backlog, which is the obvious way to get this
// wrong (ADR-0007).
func perTenantCap(limit, tenants int) int {
	if tenants <= 0 {
		return limit
	}
	return int(math.Max(1, math.Ceil(float64(limit)/float64(tenants))))
}

// tenantBatch returns the shuffled tenant pairs to drive one claim, refreshing
// the snapshot if it has gone stale.
func (q *PostgresQueue) tenantBatch(ctx context.Context, limit int) ([]tenant, error) {
	q.mu.Lock()
	stale := time.Since(q.snapshotAt) >= q.snapshotTTL
	q.mu.Unlock()

	if stale {
		if err := q.refreshSnapshot(ctx, limit*4); err != nil {
			return nil, err
		}
	}

	q.mu.Lock()
	defer q.mu.Unlock()
	return pickTenants(q.snapshot, limit, q.rng), nil
}

// pickTenants shuffles a copy of the snapshot and takes K = min(len, limit)
// pairs. The shuffle matters: without it the claim's outer LIMIT would
// systematically truncate whichever tenants sort last in the array, which is
// starvation wearing a fairness costume.
func pickTenants(snapshot []tenant, limit int, rng *rand.Rand) []tenant {
	if len(snapshot) == 0 || limit <= 0 {
		return nil
	}
	out := make([]tenant, len(snapshot))
	copy(out, snapshot)
	rng.Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

// refreshSnapshot re-enumerates tenants with ready work, resuming from the
// rotating cursor. A short result means we reached the end of the ready set, so
// the cursor wraps - that wrap is what circulates tenants beyond one snapshot's
// worth through successive refreshes.
func (q *PostgresQueue) refreshSnapshot(ctx context.Context, size int) error {
	if size <= 0 {
		size = 1
	}
	q.mu.Lock()
	org, project := q.cursorOrg, q.cursorProject
	q.mu.Unlock()

	rows, err := q.pool.Query(ctx, tenantSnapshotSQL, org, project, size)
	if err != nil {
		return fmt.Errorf("refresh tenant snapshot: %w", err)
	}
	defer rows.Close()

	var found []tenant
	for rows.Next() {
		var t tenant
		if err := rows.Scan(&t.OrganizationID, &t.ProjectID); err != nil {
			return fmt.Errorf("scan tenant snapshot: %w", err)
		}
		found = append(found, t)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate tenant snapshot: %w", err)
	}

	q.mu.Lock()
	defer q.mu.Unlock()
	q.snapshot = found
	q.snapshotAt = time.Now()
	if len(found) < size {
		q.cursorOrg, q.cursorProject = "", ""
	} else {
		last := found[len(found)-1]
		q.cursorOrg, q.cursorProject = last.OrganizationID, last.ProjectID
	}
	return nil
}

func scanLeases(rows pgx.Rows, workerID string) ([]Lease, error) {
	defer rows.Close()

	var leases []Lease
	for rows.Next() {
		var (
			job       DeliveryJob
			expiresAt time.Time
			delaySecs float64
		)
		if err := rows.Scan(
			&job.DeliveryID, &job.EventID, &job.EndpointID,
			&job.OrganizationID, &job.ProjectID,
			&job.Attempt, &job.ScheduledAt, &job.OrderingKey, &expiresAt, &delaySecs,
			&job.TraceContext,
		); err != nil {
			return nil, fmt.Errorf("scan claimed delivery: %w", err)
		}
		leases = append(leases, Lease{
			Job:             job,
			WorkerID:        workerID,
			ExpiresAt:       expiresAt,
			HeadOfLineDelay: time.Duration(delaySecs * float64(time.Second)),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate claimed deliveries: %w", err)
	}
	return leases, nil
}

// renewSQL returns the ids it actually extended. The RETURNING clause is the
// whole point: a row count alone cannot say WHICH lease was lost, and the
// caller needs the id to cancel that specific in-flight attempt.
const renewSQL = `
UPDATE deliveries
SET locked_until = now() + $3::interval,
    updated_at   = now()
WHERE id = ANY($2::text[])
  AND locked_by = $1
  AND status = 'processing'
RETURNING id`

func (q *PostgresQueue) Renew(ctx context.Context, workerID string, deliveryIDs []string, lease time.Duration) ([]string, error) {
	if len(deliveryIDs) == 0 {
		return nil, nil
	}
	rows, err := q.pool.Query(ctx, renewSQL, workerID, deliveryIDs, intervalOf(lease))
	if err != nil {
		return nil, fmt.Errorf("renew leases: %w", err)
	}
	defer rows.Close()

	renewed := make(map[string]struct{}, len(deliveryIDs))
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan renewed lease: %w", err)
		}
		renewed[id] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate renewed leases: %w", err)
	}

	// Anything we asked about and did not get back is no longer ours: it
	// expired and another worker claimed it, or the row moved on. The caller
	// must abandon those attempts rather than write a second delivery_attempts
	// row and race over the terminal status.
	var lost []string
	for _, id := range deliveryIDs {
		if _, ok := renewed[id]; !ok {
			lost = append(lost, id)
		}
	}
	return lost, nil
}

// releaseSQL only affects rows this worker still holds. The locked_by guard
// matters: without it a worker whose lease already expired - and whose delivery
// another worker has since picked up - would clobber the new owner's claim.
const releaseSQL = `
UPDATE deliveries
SET status       = 'pending',
    locked_by    = NULL,
    locked_until = NULL,
    updated_at   = now()
WHERE id = $2
  AND locked_by = $1`

func (q *PostgresQueue) Release(ctx context.Context, workerID, deliveryID string) error {
	tag, err := q.pool.Exec(ctx, releaseSQL, workerID, deliveryID)
	if err != nil {
		return fmt.Errorf("release delivery %s: %w", deliveryID, err)
	}
	if tag.RowsAffected() == 0 {
		// The lease had already lapsed and been reclaimed. Not a transport
		// failure, but the caller must know: whatever it was about to record
		// against this delivery belongs to another worker now.
		return fmt.Errorf("release delivery %s: %w", deliveryID, ErrLeaseLost)
	}
	return nil
}

// ReclaimExpired is run by the scheduler and is NOT cosmetic.
//
// Claim does treat an expired lease as claimable (see claimStatuses), so this
// is not the only recovery path - but it is the one that works when no worker
// is polling the affected rows, and it is what puts abandoned rows back inside
// the ready-set predicate rather than leaving them as `processing` outliers
// that every index and every operator query has to special-case.
//
// The coupling this comment used to describe is gone: `deliveries_ready_idx`
// and `deliveries_ready_fifo_idx` both now include `processing` in their
// partial predicate (migration 20260907000000), so an expired lease IS inside
// the index and the indexed claim path finds it cheaply. This sweep is
// therefore a convenience - it normalises abandoned rows back to `pending` so
// they stop being `processing` outliers that every operator query special-cases
// - and not the only efficient route back into the ready set.
const reclaimSQL = `
UPDATE deliveries
SET status       = 'pending',
    locked_by    = NULL,
    locked_until = NULL,
    updated_at   = now()
WHERE status = 'processing'
  AND locked_until IS NOT NULL
  AND locked_until < now()`

func (q *PostgresQueue) ReclaimExpired(ctx context.Context) (int64, error) {
	tag, err := q.pool.Exec(ctx, reclaimSQL)
	if err != nil {
		return 0, fmt.Errorf("reclaim expired leases: %w", err)
	}
	if n := tag.RowsAffected(); n > 0 {
		metrics.LeasesReclaimed.Add(float64(n))
		return n, nil
	}
	return 0, nil
}

func intervalOf(d time.Duration) string {
	return fmt.Sprintf("%d milliseconds", d.Milliseconds())
}

var _ Queue = (*PostgresQueue)(nil)
