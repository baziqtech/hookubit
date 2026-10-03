// Package retention prunes the delivery ledger.
//
// # The gap it closes
//
// Nothing in either plane ever deleted a terminal delivery or its attempt rows,
// so `deliveries` and `delivery_attempts` grew for the life of the installation
// (docs/FAILURE_RECOVERY.md, G14, "No retention"). Every other table in the
// system is bounded by something - the outbox drains, the queue's ready set is
// bounded by the retry duration, idempotency keys expire - and these two were
// not bounded by anything at all.
//
// # The thing to be careful about
//
// This package deletes the answer to "did finance ever receive this?". That
// makes it the one background job here where being too eager is strictly worse
// than doing nothing: an unpruned table costs disk, a wrongly pruned one costs
// the product its operator surface. Four separate bounds exist for that reason
// and none of them is decoration:
//
//   - TWO HORIZONS, not one. The bulky half (request/response headers and
//     bodies, in delivery_attempts) is reclaimed at the shorter horizon; the
//     SUMMARY row - status, attempt_count, last_error, which endpoint, which
//     event - survives to the longer one. Most of the bytes go early and most
//     of the answers stay.
//   - A FLOOR under both horizons (Config.MinimumAge), because a delivery is
//     live until its wall-clock retry budget expires.
//   - A PER-BATCH bound, so no statement holds row locks long enough to be
//     noticed by the workers writing next to it.
//   - A PER-RUN bound, so the first pass against a table that has never been
//     pruned drains over hours instead of becoming an incident.
//
// # Where it runs
//
// The scheduler role. It is periodic reconciliation of state nothing else owns,
// which is exactly what that role already carries (the orphan payload sweep and
// the queue-depth collector), and it is far too infrequent to deserve a
// process. It takes no lease: every statement is bounded, idempotent and
// self-terminating, so running two of these concurrently is wasteful and
// harmless rather than unsafe.
//
// # Resumability
//
// There is no cursor and no checkpoint. Each statement's own WHERE clause is
// the position: a delivery this package touches leaves the candidate set in the
// same transaction that touched it. A run killed by SIGTERM, a failover or a
// batch timeout loses only the batch that was in flight, and that batch rolled
// back. See the commentary on pruneAttemptsSQL.
package retention

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// DB is the slice of *pgxpool.Pool this package needs. An interface rather than
// the pool itself so the batching, the ceilings and the error handling can be
// tested without a database - the SQL still needs one, and has its own test.
type DB interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Report is what one pass did. Returned rather than only logged so a test - and
// a future metric - can assert on it.
type Report struct {
	// AttemptsDeleted is delivery_attempts rows removed at the short horizon.
	AttemptsDeleted int64
	// DeliveriesMarked is delivery rows whose attempt detail was pruned.
	DeliveriesMarked int64
	// DeliveriesDeleted is delivery rows removed at the long horizon. Their
	// remaining attempts went with them by cascade and are NOT counted in
	// AttemptsDeleted.
	DeliveriesDeleted int64
	// Truncated is true when the pass stopped on MaxDeletesPerRun rather than
	// because it ran out of rows. It means there is a backlog: either this
	// installation has never been pruned before, or the ceiling is below the
	// rate at which deliveries go terminal.
	Truncated bool
}

// Empty reports whether the pass found nothing to do, which is the steady state
// and the reason a healthy run logs at DEBUG rather than INFO.
func (r Report) Empty() bool {
	return r.AttemptsDeleted == 0 && r.DeliveriesMarked == 0 && r.DeliveriesDeleted == 0
}

// Sweeper prunes the ledger on a ticker.
type Sweeper struct {
	db  DB
	cfg Config
	log *slog.Logger
}

// New builds a Sweeper. It refuses an invalid policy rather than correcting it:
// every field here bounds how much of the delivery ledger is destroyed, and a
// silently substituted default is the wrong failure mode for that.
func New(db DB, cfg Config, log *slog.Logger) (*Sweeper, error) {
	if db == nil {
		return nil, errors.New("retention: DB is required")
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if log == nil {
		log = slog.Default()
	}
	return &Sweeper{db: db, cfg: cfg, log: log}, nil
}

// Run prunes until ctx is cancelled, returning nil on cancellation.
//
// The FIRST pass is deliberately delayed by one interval rather than run at
// startup. A scheduler pod restarting in a crash loop would otherwise run a
// retention pass per restart, and the one job in this system that should never
// be triggered by an unhealthy process is the one that deletes rows.
func (s *Sweeper) Run(ctx context.Context) error {
	if !s.cfg.Enabled {
		s.log.Warn("delivery ledger retention is disabled; deliveries and delivery_attempts will grow without bound",
			"remedy", "set RETENTION_ENABLED=true")
		return nil
	}
	s.log.Info("delivery ledger retention started",
		"interval", s.cfg.Interval.String(),
		"delivery_age", s.cfg.DeliveryAge.String(),
		"attempt_age", s.cfg.AttemptAge.String(),
		"batch_size", s.cfg.BatchSize,
		"max_deletes_per_run", s.cfg.MaxDeletesPerRun)

	ticker := time.NewTicker(s.cfg.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			report, err := s.RunOnce(ctx)
			if err != nil && ctx.Err() == nil {
				// Logged and retried on the next tick. A retention pass that
				// cannot finish must never take the scheduler down with it -
				// the scheduler also owns lease reclaim, which deliveries
				// depend on and disk space does not.
				s.log.Error("delivery ledger retention pass failed", "error", err)
				continue
			}
			s.report(report)
		}
	}
}

// RunOnce performs one pass. Exported so an operator command, or a test, can
// drive a single pass without a ticker.
//
// ORDER MATTERS. Attempts are pruned before deliveries: doing it the other way
// round would delete delivery rows whose attempts the short sweep had not yet
// reached, cascading them away and making AttemptsDeleted an undercount of what
// was actually destroyed. It also means the cheap statement runs first, so a
// pass that is going to hit its ceiling spends the budget on the bulk.
func (s *Sweeper) RunOnce(ctx context.Context) (Report, error) {
	var report Report

	budget := s.cfg.MaxDeletesPerRun
	attempts, marked, spent, err := s.pruneAttempts(ctx, budget)
	report.AttemptsDeleted, report.DeliveriesMarked = attempts, marked
	if err != nil {
		return report, err
	}
	budget -= spent
	if budget <= 0 {
		report.Truncated = true
		return report, nil
	}

	deleted, truncated, err := s.pruneDeliveries(ctx, budget)
	report.DeliveriesDeleted = deleted
	report.Truncated = truncated
	return report, err
}

// pruneAttempts drains the short horizon, batch by batch, and reports how much
// of the run budget it spent.
//
// The budget is charged in DELIVERIES, not in attempt rows. A delivery is the
// unit of work the batch bounds and the unit an operator reasons about; charging
// per attempt would make the effective batch count depend on how many times each
// delivery happened to be retried.
func (s *Sweeper) pruneAttempts(ctx context.Context, budget int) (attempts, marked int64, spent int, err error) {
	for budget > 0 {
		limit := s.cfg.BatchSize
		if limit > budget {
			limit = budget
		}
		batchAttempts, batchMarked, err := s.pruneAttemptsBatch(ctx, limit)
		attempts += batchAttempts
		marked += batchMarked
		spent += int(batchMarked)
		if err != nil {
			return attempts, marked, spent, err
		}
		// A short batch means the candidate set is exhausted. Marked, not
		// attempts: a terminal delivery that was never attempted at all (a
		// cancelled one, or one exhausted behind an open breaker) contributes a
		// mark and zero attempt rows, and stopping on a zero attempt count
		// would leave those deliveries unmarked and re-scanned forever.
		if int(batchMarked) < limit {
			return attempts, marked, spent, nil
		}
		budget -= int(batchMarked)
	}
	return attempts, marked, spent, nil
}

func (s *Sweeper) pruneAttemptsBatch(ctx context.Context, limit int) (attempts, marked int64, err error) {
	ctx, cancel := context.WithTimeout(ctx, s.cfg.BatchTimeout)
	defer cancel()

	rows, err := s.db.Query(ctx, pruneAttemptsSQL, intervalOf(s.cfg.AttemptAge), limit)
	if err != nil {
		return 0, 0, fmt.Errorf("prune delivery attempts: %w", err)
	}
	defer rows.Close()

	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return 0, 0, fmt.Errorf("prune delivery attempts: %w", err)
		}
		// The statement always produces exactly one row (two scalar
		// subqueries); no row means something below us changed shape.
		return 0, 0, errors.New("prune delivery attempts: statement returned no counts")
	}
	if err := rows.Scan(&attempts, &marked); err != nil {
		return 0, 0, fmt.Errorf("prune delivery attempts: scan counts: %w", err)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, 0, fmt.Errorf("prune delivery attempts: %w", err)
	}
	AttemptsPruned.Add(float64(attempts))
	return attempts, marked, nil
}

// pruneDeliveries drains the long horizon.
func (s *Sweeper) pruneDeliveries(ctx context.Context, budget int) (deleted int64, truncated bool, err error) {
	for budget > 0 {
		limit := s.cfg.BatchSize
		if limit > budget {
			limit = budget
		}
		n, err := s.pruneDeliveriesBatch(ctx, limit)
		deleted += n
		if err != nil {
			return deleted, false, err
		}
		if int(n) < limit {
			return deleted, false, nil
		}
		budget -= int(n)
	}
	return deleted, true, nil
}

func (s *Sweeper) pruneDeliveriesBatch(ctx context.Context, limit int) (int64, error) {
	ctx, cancel := context.WithTimeout(ctx, s.cfg.BatchTimeout)
	defer cancel()

	tag, err := s.db.Exec(ctx, pruneDeliveriesSQL, intervalOf(s.cfg.DeliveryAge), limit)
	if err != nil {
		return 0, fmt.Errorf("prune deliveries: %w", err)
	}
	n := tag.RowsAffected()
	DeliveriesPruned.Add(float64(n))
	return n, nil
}

// report says what happened, at a level that matches whether anyone needs to
// know. A quiet steady state must not fill the log, and a truncated pass must
// not be quiet.
func (s *Sweeper) report(r Report) {
	switch {
	case r.Truncated:
		s.log.Warn("delivery ledger retention hit its per-run ceiling; a backlog remains",
			"attempts_deleted", r.AttemptsDeleted,
			"deliveries_marked", r.DeliveriesMarked,
			"deliveries_deleted", r.DeliveriesDeleted,
			"max_deletes_per_run", s.cfg.MaxDeletesPerRun,
			"note", "expected on the first passes after retention is switched on; if it persists, raise RETENTION_MAX_DELETES_PER_RUN or shorten RETENTION_INTERVAL_MS")
	case r.Empty():
		s.log.Debug("delivery ledger retention found nothing to prune")
	default:
		s.log.Info("delivery ledger retention pass complete",
			"attempts_deleted", r.AttemptsDeleted,
			"deliveries_marked", r.DeliveriesMarked,
			"deliveries_deleted", r.DeliveriesDeleted)
	}
}

// intervalOf renders a duration as a PostgreSQL interval literal.
//
// Seconds, not the duration's own String(): Go prints "2160h0m0s", and
// PostgreSQL parses "2160h0m0s" as nothing at all.
func intervalOf(d time.Duration) string {
	return fmt.Sprintf("%d seconds", int64(d/time.Second))
}
