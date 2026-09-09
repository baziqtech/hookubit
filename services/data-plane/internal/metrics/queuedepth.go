package metrics

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
)

// QueueDepth was declared and never written, so it read a steady zero forever -
// which is the worst possible failure mode for a backlog gauge. A metric that
// is absent prompts a question; a metric that reads zero answers one, wrongly.
//
// It matters more than a normal gauge here because several confirmed failure
// modes are INVISIBLE in every other instrument. A delivery deferred by an open
// circuit breaker, or by a rate limit, is not an attempt: it produces no
// delivery_attempts row, no egress_http_responses_total, no
// delivery_attempt_latency_seconds. The rows simply accumulate. Counters of
// things that happened cannot show you work that is not happening, and this is
// the gauge that can.
//
// # Cardinality
//
// `state` takes exactly the three values below and is never derived from a
// tenant, project or endpoint. A per-tenant depth gauge grows a time series per
// customer forever - including for customers who churned - and is the trap the
// package header warns about. Per-tenant backlog questions are answered from
// the delivery log.
const (
	// StateReady is a delivery a worker could claim right now: due, and not
	// held by a live lease. Sustained growth here is the backlog signal, and
	// this is the series to autoscale workers on (the HPA comment in
	// deployments/ says CPU is a proxy - this is the real thing).
	StateReady = "ready"
	// StateDelayed is a delivery waiting out its backoff. A large delayed count
	// with a small ready count is a healthy retry queue; a delayed count that
	// only grows is a fleet of endpoints that stopped answering.
	StateDelayed = "delayed"
	// StateInFlight is a delivery leased by a worker that is still within its
	// lease. This should track roughly (workers x concurrency); if it is far
	// below that while ready is large, the workers are not claiming.
	StateInFlight = "in_flight"
)

// queueDepthSQL classifies every non-terminal delivery exactly the way
// queue.PostgresQueue's claim predicate does, because a depth gauge that
// disagrees with the claim query is a graph that says "no work" while workers
// idle next to a full table.
//
// The status list, the next_attempt_at NULL handling and the locked_until
// comparison are all mirrored from internal/queue/postgres.go (claimStatuses,
// readyPredicate). `processing` is in the list on purpose: a row whose lease
// has expired is claimable again, and it must be counted as ready, not as
// in-flight, or a fleet of dead workers looks like a busy one.
//
// COST. This is one aggregate over the non-terminal rows. It is affordable at
// the default interval and it is not free: at tens of millions of live rows it
// wants a partial index -
//
//	CREATE INDEX CONCURRENTLY deliveries_ready_idx ON deliveries (next_attempt_at, created_at)
//	  WHERE status IN ('pending','scheduled','queued','retrying','processing');
//
// which the claim path wants anyway (ADR-0007). The DDL belongs to the control
// plane, which owns every migration (ADR-0002); this file must never create it.
const queueDepthSQL = `
SELECT CASE
         WHEN locked_until IS NOT NULL AND locked_until >= now() THEN 'in_flight'
         WHEN next_attempt_at IS NULL OR next_attempt_at <= now() THEN 'ready'
         ELSE 'delayed'
       END AS state,
       count(*)::bigint
FROM deliveries
WHERE status IN ('pending', 'scheduled', 'queued', 'retrying', 'processing')
GROUP BY 1`

// Querier is the slice of *pgxpool.Pool this collector needs. Taking an
// interface keeps package metrics off internal/queue, which imports THIS
// package - the cycle is not hypothetical, it is what happens the moment the
// gauge is refreshed from the queue implementation.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// QueueDepthCollector refreshes queue_depth on a ticker.
//
// It is a READER. It takes no lease, claims nothing and writes nothing, so it
// is safe to run in any role and in any number of replicas - every replica
// simply reports the same fleet-wide numbers, and Prometheus keeps them apart
// by instance. The natural home is the scheduler (one replica by design, and
// already the role that sweeps the table), which is where wiring it costs one
// goroutine.
type QueueDepthCollector struct {
	db       Querier
	interval time.Duration
	timeout  time.Duration
	log      *slog.Logger
}

// NewQueueDepthCollector builds a collector. A non-positive interval takes the
// default; the per-query timeout is derived from it so a stalled query can
// never overlap the next tick.
func NewQueueDepthCollector(db Querier, interval time.Duration, log *slog.Logger) *QueueDepthCollector {
	if interval <= 0 {
		interval = 15 * time.Second
	}
	if log == nil {
		log = slog.Default()
	}
	timeout := interval / 2
	if timeout > 5*time.Second {
		timeout = 5 * time.Second
	}
	if timeout < time.Second {
		timeout = time.Second
	}
	return &QueueDepthCollector{db: db, interval: interval, timeout: timeout, log: log}
}

// Run refreshes the gauge until ctx is cancelled. It returns nil on
// cancellation: a metrics refresher must never be the reason a role exits.
//
// A failed refresh is logged and skipped, and the gauge holds its previous
// value rather than dropping to zero - a database that cannot be queried is not
// evidence that the queue is empty, and staleness is visible from the scrape
// timestamps in a way that a fabricated zero is not.
func (c *QueueDepthCollector) Run(ctx context.Context) error {
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()

	if err := c.Refresh(ctx); err != nil && ctx.Err() == nil {
		c.log.Warn("queue depth refresh failed", "error", err)
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := c.Refresh(ctx); err != nil && ctx.Err() == nil {
				c.log.Warn("queue depth refresh failed", "error", err)
			}
		}
	}
}

// Refresh performs one pass. Exported so a role can prime the gauge before it
// starts serving, and so it can be tested without a clock.
func (c *QueueDepthCollector) Refresh(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	rows, err := c.db.Query(ctx, queueDepthSQL)
	if err != nil {
		return fmt.Errorf("query queue depth: %w", err)
	}
	defer rows.Close()

	// Every state is seeded to zero. A state that disappears between two passes
	// - the last in-flight delivery finishing, say - must be published as zero,
	// not left at its last value, or the graph shows work that is no longer
	// there until the process restarts.
	counts := map[string]float64{StateReady: 0, StateDelayed: 0, StateInFlight: 0}
	for rows.Next() {
		var (
			state string
			n     int64
		)
		if err := rows.Scan(&state, &n); err != nil {
			return fmt.Errorf("scan queue depth row: %w", err)
		}
		if _, known := counts[state]; !known {
			// Unreachable while the CASE above is the only producer, and
			// deliberately dropped rather than published: an unexpected label
			// value from a query is exactly how an unbounded label starts.
			c.log.Warn("queue depth returned an unknown state", "state", state)
			continue
		}
		counts[state] = float64(n)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read queue depth rows: %w", err)
	}

	for state, n := range counts {
		QueueDepth.WithLabelValues(state).Set(n)
	}
	return nil
}
